import { systemClock, type Clock } from "./clock";
import { BackroomError, fileNotFound } from "./errors";
import {
  BUILT_IN_PROPERTIES,
  inferPropertyType,
  inferValueType,
  parsePropertyValue,
  removeProperty,
  setProperty,
  type PropertyValue,
  type PropertyValueType,
} from "./frontmatter";
import { VaultLock } from "./lock";
import { planMove } from "./move";
import { parseNote, type JsonValue, type Note, type Properties } from "./note";
import { loadPlugins } from "./plugins";
import {
  basename,
  compareCodeUnits,
  compareNames,
  dirname,
  extension,
  isHidden,
  isMarkdown,
  join,
  normalize,
  stem,
  validateFileName,
} from "./paths";
import { matchFile, parseQuery, type FileMatch } from "./search";
import { Vault, type PropertyType, type VaultFile } from "./vault";
import type { CommitChange, Git } from "./git";
import { applyChanges, TRASH_FOLDER, type AppliedChange, type Change } from "./write";

/** How a command names a file: `path=` is the exact vault path, `file=` resolves like a wikilink. */
export type FileRef = { path: string } | { file: string };

export type OutlineHeading = { level: number; heading: string; line: number };
export type TagCount = { tag: string; count: number };
export type OutgoingLink = { target: string; resolved: boolean };
export type Backlink = { file: string; count: number };
export type Alias = { alias: string; path: string };
export type UnresolvedLink = { link: string; count: number; sources: string[] };
export type PropertyCount = { name: string; type: PropertyType | "unknown"; count: number };

/** A write that was applied, described for the caller and for the commit that records it. */
export type WriteResult = { operation: string; summary: string; changes: AppliedChange[]; warnings: string[] };

/** What happens around every write, such as pulling before and committing after (ADR 6). */
export type WriteHooks = {
  beforeWrite(): Promise<void>;
  /** Returns warnings for the caller, for example when the commit failed although the write succeeded. */
  afterWrite(result: WriteResult): Promise<string[]>;
};

export type EngineOptions = { git?: Git; clock?: Clock; lock?: VaultLock };

/**
 * What a write plans: the changes, and the note it saves when the command creates or changes one, which the
 * vault's plugins see (ADR 7). Notes changed as a side effect, such as links a rename updates, are not saved.
 */
type Plan = { operation: string; summary: string; changes: Change[]; saved?: string };

/**
 * The vault engine. Every operation of the CLI and the MCP server exists here once. Reads load a fresh picture of
 * the vault, writes are planned against it and applied through the single write path.
 */
export class Engine {
  private queue: Promise<unknown> = Promise.resolve();

  readonly git: Git | null;
  private readonly clock: Clock;
  private readonly lock: VaultLock;

  constructor(
    readonly root: string,
    options: EngineOptions = {},
  ) {
    this.git = options.git ?? null;
    this.clock = options.clock ?? systemClock;
    this.lock = options.lock ?? VaultLock.of(root);
  }

  async vault(): Promise<Vault> {
    return Vault.load(this.root);
  }

  // Reading notes

  async read(ref: FileRef): Promise<{ path: string; text: string; version: string }> {
    const vault = await this.vault();
    const path = resolveRef(vault, ref);
    return { path, text: textOf(vault, path), version: vault.version(path) };
  }

  async fileInfo(ref: FileRef): Promise<VaultFile & { version: string | null }> {
    const vault = await this.vault();
    const path = resolveRef(vault, ref);
    return { ...vault.file(path), version: vault.entry(path)?.text === null ? null : vault.version(path) };
  }

  async outline(ref: FileRef): Promise<OutlineHeading[]> {
    const vault = await this.vault();
    const path = resolveMarkdown(vault, ref);
    return vault
      .note(path)
      .headings.map((heading) => ({ level: heading.level, heading: heading.text, line: heading.line + 1 }));
  }

  /** A note's properties and their YAML as written, or null when it has no frontmatter Obsidian can read. */
  async properties(ref: FileRef): Promise<{ path: string; properties: Properties; yaml: string } | null> {
    const vault = await this.vault();
    const path = resolveMarkdown(vault, ref);
    const note = vault.note(path);
    if (note.frontmatter.kind !== "valid") return null;
    const yaml = vault.text(path).slice(note.frontmatter.yamlSpan.start, note.frontmatter.yamlSpan.end);
    return { path, properties: note.properties, yaml };
  }

  /**
   * The vault's properties with how many notes have each, including Obsidian's built-in ones. The type is the one
   * in `.obsidian/types.json`, else the one Obsidian infers from the first value.
   */
  async propertyNames(): Promise<PropertyCount[]> {
    const vault = await this.vault();
    const counts = new Map<string, PropertyCount>(
      Object.entries(BUILT_IN_PROPERTIES).map(([name, type]) => [name, { name, type, count: 0 }]),
    );
    for (const path of vault.markdownPaths()) {
      for (const [name, value] of Object.entries(vault.note(path).properties)) {
        const entry = counts.get(name) ?? { name, type: inferPropertyType(value), count: 0 };
        entry.count++;
        counts.set(name, entry);
      }
    }
    return [...counts.values()]
      .map((entry) => ({ ...entry, type: vault.settings.propertyTypes[entry.name] ?? entry.type }))
      .sort((a, b) => compareNames(a.name, b.name));
  }

  async propertyRead(ref: FileRef, name: string): Promise<JsonValue> {
    const vault = await this.vault();
    const path = resolveMarkdown(vault, ref);
    const properties = vault.note(path).properties;
    if (!(name in properties)) throw new BackroomError("not_found", `Property "${name}" not found.`);
    return properties[name]!;
  }

  /** The tags of a note with how often each occurs. Unlike the vault's tags, `#idea` and `#Idea` stay apart. */
  async tagsOf(ref: FileRef): Promise<TagCount[]> {
    const vault = await this.vault();
    const counts = new Map<string, TagCount>();
    for (const tag of vault.note(resolveMarkdown(vault, ref)).tagOccurrences) {
      const entry = counts.get(tag) ?? { tag, count: 0 };
      entry.count++;
      counts.set(tag, entry);
    }
    return [...counts.values()].sort((a, b) => compareNames(a.tag, b.tag));
  }

  /**
   * Every tag in the vault with how often it occurs, including each parent of a nested tag. Excluded files do not
   * count.
   */
  async tags(): Promise<TagCount[]> {
    return vaultTags(await this.vault());
  }

  /**
   * A tag from the vault's tag list, named in the case the list shows it, with the notes that carry exactly this
   * tag. The count is the one the tag list shows. Unlike the count, the notes include excluded files, as in the
   * Obsidian CLI.
   */
  async tag(name: string): Promise<{ tag: string; count: number; files: string[] }> {
    const vault = await this.vault();
    const wanted = name.replace(/^#/, "");
    const entry = vaultTags(vault).find((candidate) => candidate.tag === wanted);
    if (!entry) throw new BackroomError("not_found", `Tag "#${wanted}" not found.`);
    const files = vault
      .markdownPaths()
      .filter((path) => vault.note(path).tags.some((tag) => tag.toLowerCase() === wanted.toLowerCase()));
    return { ...entry, files };
  }

  async aliases(ref?: FileRef): Promise<Alias[]> {
    const vault = await this.vault();
    const paths = ref ? [resolveMarkdown(vault, ref)] : vault.markdownPaths();
    return paths.flatMap((path) => vault.note(path).aliases.map((alias) => ({ alias, path })));
  }

  // Links

  /**
   * The distinct files a note links to, and the link paths that resolve to no file. Unlike the other listings,
   * the Obsidian CLI sorts these by code units, so "Zeta.md" comes before "alpha.md".
   */
  async links(ref: FileRef): Promise<OutgoingLink[]> {
    const vault = await this.vault();
    const path = resolveMarkdown(vault, ref);
    const seen = new Map<string, OutgoingLink>();
    for (const { link, target } of vault.outgoing(path)) {
      const entry = target === null ? { target: link.target, resolved: false } : { target, resolved: true };
      seen.set(`${entry.resolved}:${entry.target}`, entry);
    }
    return [...seen.values()].sort((a, b) => compareCodeUnits(a.target, b.target));
  }

  async backlinks(ref: FileRef): Promise<Backlink[]> {
    const vault = await this.vault();
    const path = resolveRef(vault, ref);
    return [...vault.backlinks(path)]
      .map(([file, links]) => ({ file, count: links.length }))
      .sort((a, b) => compareNames(a.file, b.file));
  }

  /** Link paths that resolve to no file, named without a `.md` extension and told apart by case, like Obsidian. */
  async unresolved(): Promise<UnresolvedLink[]> {
    const vault = await this.vault();
    const result = new Map<string, UnresolvedLink>();
    for (const [source, links] of vault.allResolvedLinks()) {
      for (const { link, target } of links) {
        if (target !== null || link.target === "") continue;
        const name = link.target.replace(/\.md$/i, "");
        const entry = result.get(name) ?? { link: name, count: 0, sources: [] };
        entry.count++;
        if (!entry.sources.includes(source)) entry.sources.push(source);
        result.set(name, entry);
      }
    }
    for (const entry of result.values()) entry.sources.sort(compareCodeUnits);
    return [...result.values()].sort((a, b) => compareNames(a.link, b.link));
  }

  /**
   * Files that no other note links to. Like the Obsidian CLI, this includes attachments, although its help says
   * that only the `all` flag does.
   */
  async orphans(): Promise<string[]> {
    const vault = await this.vault();
    const linked = new Set<string>();
    for (const [source, links] of vault.allResolvedLinks()) {
      for (const { target } of links) if (target !== null && target !== source) linked.add(target);
    }
    return vault
      .files()
      .map((file) => file.path)
      .filter((path) => !linked.has(path));
  }

  /** Files without outgoing links, which includes every attachment, as in the Obsidian CLI. */
  async deadends(): Promise<string[]> {
    const vault = await this.vault();
    return vault
      .files()
      .map((file) => file.path)
      .filter((path) => vault.entry(path)?.text === null || vault.note(path).links.length === 0);
  }

  // Listing and search

  async files(options: { folder?: string; ext?: string }): Promise<VaultFile[]> {
    const vault = await this.vault();
    const folder = options.folder === undefined ? undefined : normalizeFolder(options.folder);
    const ext = options.ext?.replace(/^\./, "").toLowerCase();
    return vault.files().filter((file) => {
      if (folder !== undefined && folder !== "" && !file.path.startsWith(`${folder}/`)) return false;
      return ext === undefined || extension(file.path).toLowerCase() === ext;
    });
  }

  /** Folders at or below `folder`, the vault root (`""`) included when there is no filter. */
  async folders(options: { folder?: string }): Promise<string[]> {
    const vault = await this.vault();
    const folder = options.folder === undefined ? "" : normalizeFolder(options.folder);
    return ["", ...vault.folders()].filter((path) => folder === "" || path === folder || path.startsWith(`${folder}/`));
  }

  async search(
    query: string,
    options: { folder?: string; limit?: number; caseSensitive?: boolean },
  ): Promise<FileMatch[]> {
    const vault = await this.vault();
    const searchOptions = { caseSensitive: options.caseSensitive ?? false };
    const parsed = parseQuery(query, searchOptions);
    const folder = options.folder === undefined ? "" : normalizeFolder(options.folder);
    const matches: FileMatch[] = [];
    for (const path of includedNotes(vault)) {
      if (folder !== "" && !path.startsWith(`${folder}/`)) continue;
      const match = matchFile(parsed, { path, text: vault.text(path), note: vault.note(path) }, searchOptions);
      if (match) matches.push(match);
      if (options.limit !== undefined && matches.length >= options.limit) break;
    }
    return matches;
  }

  async wordcount(ref: FileRef): Promise<{ words: number; characters: number }> {
    const vault = await this.vault();
    const text = vault.text(resolveMarkdown(vault, ref));
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "");
    return { words: body.match(WORD)?.length ?? 0, characters: body.length };
  }

  async info(): Promise<{ name: string; path: string; files: number; folders: number; size: number }> {
    const vault = await this.vault();
    const files = vault.files();
    return {
      name: basename(this.root.replace(/\/+$/, "")),
      path: this.root,
      files: files.length,
      folders: vault.folders().length,
      size: files.reduce((sum, file) => sum + file.size, 0),
    };
  }

  // Writing

  /**
   * Creates a note. When the path is taken, the note gets a free name like "Note 1.md", as in Obsidian. An existing
   * file is only replaced with `overwrite`, and then only when `version` names the version the new content is based on.
   */
  async create(options: {
    target: FileTarget;
    content: string;
    overwrite?: boolean;
    version?: string;
  }): Promise<WriteResult> {
    return this.write(async (vault) => {
      const path = newFilePath(vault, options.target);
      const existing = vault.fileIgnoringCase(path);
      if (existing && !options.overwrite) {
        const free = freePath(vault, path);
        return {
          operation: "create",
          summary: `Created: ${free}`,
          changes: [{ kind: "create", path: free, text: options.content }],
          saved: free,
        };
      }
      if (existing) {
        if (options.version === undefined) {
          throw new BackroomError(
            "invalid_argument",
            `Overwriting "${existing.path}" needs the version it replaces (version=).`,
          );
        }
        checkVersion(vault, existing.path, options.version);
        return {
          operation: "create",
          summary: `Overwrote: ${existing.path}`,
          changes: [{ kind: "modify", path: existing.path, baseVersion: options.version, text: options.content }],
          saved: existing.path,
        };
      }
      return {
        operation: "create",
        summary: `Created: ${path}`,
        changes: [{ kind: "create", path, text: options.content }],
        saved: path,
      };
    });
  }

  /** Adds content at the end of a note after a newline, unless `inline`. Like Obsidian, also after a final newline. */
  async append(
    ref: FileRef,
    content: string,
    options: { inline?: boolean; version?: string } = {},
  ): Promise<WriteResult> {
    return this.modify(ref, "append", options.version, (text, path) => {
      const separator = options.inline || text === "" ? "" : "\n";
      return { text: text + separator + content, summary: `Appended to: ${path}` };
    });
  }

  /** Adds content at the start of a note's body, after the frontmatter. */
  async prepend(
    ref: FileRef,
    content: string,
    options: { inline?: boolean; version?: string } = {},
  ): Promise<WriteResult> {
    return this.modify(ref, "prepend", options.version, (text, path, vault) => {
      const frontmatter = vault.note(path).frontmatter;
      const at = frontmatter.kind === "none" ? 0 : frontmatter.span.end;
      const separator = options.inline || content.endsWith("\n") ? "" : "\n";
      return { text: text.slice(0, at) + content + separator + text.slice(at), summary: `Prepended to: ${path}` };
    });
  }

  /**
   * Replaces an exact piece of text in a note. The text has to occur exactly once, or `all` has to be set, so an
   * edit never lands somewhere the caller did not expect.
   */
  async edit(
    ref: FileRef,
    oldText: string,
    newText: string,
    options: { all?: boolean; version?: string } = {},
  ): Promise<WriteResult> {
    if (oldText === "") throw new BackroomError("invalid_argument", "The text to replace (old=) must not be empty.");
    return this.modify(ref, "edit", options.version, (text, path) => {
      const count = text.split(oldText).length - 1;
      if (count === 0) throw new BackroomError("not_found", `The text to replace was not found in "${path}".`);
      if (count > 1 && !options.all) {
        throw new BackroomError(
          "invalid_argument",
          `The text to replace occurs ${count} times in "${path}". Give more context to make it unique, or set all.`,
        );
      }
      return {
        text: text.split(oldText).join(newText),
        summary: `Edited: ${path} (${count} ${count === 1 ? "replacement" : "replacements"})`,
      };
    });
  }

  async propertySet(ref: FileRef, name: string, rawValue: string, type?: PropertyValueType): Promise<WriteResult> {
    if (name.trim() === "") throw new BackroomError("invalid_argument", "Property name must not be empty.");
    return this.modify(ref, "property:set", undefined, (text, path, vault) => {
      const current = vault.note(path).properties[name];
      const value: PropertyValue = parsePropertyValue(
        rawValue,
        type ?? inferValueType(vault.settings.propertyTypes[name], current),
      );
      return { text: setProperty(text, name, value), summary: `Set ${name}: ${rawValue}` };
    });
  }

  async propertyRemove(ref: FileRef, name: string): Promise<WriteResult> {
    return this.modify(ref, "property:remove", undefined, (text, path) => ({
      text: removeProperty(text, name),
      summary: `Removed: ${name}`,
    }));
  }

  /** Moves a file to the vault's `.trash` folder. */
  async delete(ref: FileRef, options: { version?: string } = {}): Promise<WriteResult> {
    return this.write(async (vault) => {
      const path = resolveRef(vault, ref);
      const isNote = vault.entry(path)?.text !== null;
      if (options.version !== undefined) checkVersion(vault, path, options.version);
      return {
        operation: "delete",
        summary: `Moved to trash: ${path}`,
        changes: [{ kind: "trash", path, baseVersion: isNote ? (options.version ?? vault.version(path)) : null }],
      };
    });
  }

  /** Renames a file in its folder and updates links to it. Without an extension, the name keeps the old one. */
  async rename(ref: FileRef, name: string): Promise<WriteResult> {
    return this.write(async (vault) => {
      const from = resolveRef(vault, ref);
      if (name.includes("/"))
        throw new BackroomError("invalid_argument", "A new name cannot contain a folder. Use move instead.");
      const ext = extension(from);
      const fileName = ext !== "" && extension(name).toLowerCase() !== ext.toLowerCase() ? `${name}.${ext}` : name;
      const to = join(dirname(from), fileName);
      return { operation: "rename", summary: `Renamed: ${from} -> ${to}`, changes: planMove(vault, from, to) };
    });
  }

  /** Moves a file to a folder or a new path and updates links to it. */
  async move(ref: FileRef, destination: string): Promise<WriteResult> {
    return this.write(async (vault) => {
      const from = resolveRef(vault, ref);
      const to = moveDestination(vault, from, destination);
      return { operation: "move", summary: `Moved: ${from} -> ${to}`, changes: planMove(vault, from, to) };
    });
  }

  /**
   * Undoes a commit backroom made, as a new write: every file the commit touched gets its content from before the
   * commit, provided it has not changed since. Files the commit moved to .trash come back from there.
   */
  async revert(commit: string): Promise<WriteResult> {
    const git = this.requireGit();
    if (git.mode === "off") {
      throw new BackroomError("unsupported", "Reverting needs git. Set BACKROOM_GIT to commit or sync.");
    }
    const commitChanges = await git.commitChanges(commit);
    return this.write(async (vault) => ({
      operation: "revert",
      summary: `Reverted: ${commit}`,
      changes: planRevert(vault, commit, commitChanges),
    }));
  }

  requireGit(): Git {
    if (!this.git) throw new BackroomError("unsupported", "The vault is not a git repository.");
    return this.git;
  }

  private async modify(
    ref: FileRef,
    operation: string,
    version: string | undefined,
    change: (text: string, path: string, vault: Vault) => { text: string; summary: string },
  ): Promise<WriteResult> {
    return this.write(async (vault) => {
      const path = resolveMarkdown(vault, ref);
      if (version !== undefined) checkVersion(vault, path, version);
      const { text, summary } = change(vault.text(path), path, vault);
      checkFrontmatterStaysReadable(vault.note(path), text, path);
      const changes: Change[] =
        text === vault.text(path) ? [] : [{ kind: "modify", path, baseVersion: vault.version(path), text }];
      return { operation, summary, changes, saved: path };
    });
  }

  /** Pulls changes from the remote in sync mode, in turn with writes so a pull never lands in the middle of one. */
  async pull(): Promise<void> {
    await this.serialized(async () => this.git?.beforeWrite());
  }

  private async write(plan: (vault: Vault) => Promise<Plan>): Promise<WriteResult> {
    return this.serialized(async () => {
      await this.git?.beforeWrite();
      const vault = await this.vault();
      const { saved, ...planned } = await plan(vault);
      const toApply = saved === undefined ? planned.changes : await this.save(vault, planned.changes, saved);
      const changes = await applyChanges(this.root, toApply, (path) => vault.diskPath(path));
      const result: WriteResult = { ...planned, changes, warnings: [] };
      if (changes.length > 0 && this.git) result.warnings = await this.git.afterWrite(result);
      return result;
    });
  }

  /** Lets the vault's plugins change the note a write saves, the way they would when it is saved in Obsidian. */
  private async save(vault: Vault, changes: Change[], path: string): Promise<Change[]> {
    const plugins = await loadPlugins(this.root, vault.settings.enabledPlugins);
    if (plugins.length === 0) return changes;
    return Promise.all(
      changes.map(async (change) => {
        if ((change.kind !== "create" && change.kind !== "modify") || change.path !== path) return change;
        const before = change.kind === "modify" ? vault.text(path) : null;
        const note = { path, before, text: change.text, created: () => this.created(vault, path, before) };
        for (const plugin of plugins) note.text = await plugin.onSave(note, this.clock);
        if (before !== null) checkFrontmatterStaysReadable(vault.note(path), note.text, path);
        return { ...change, text: note.text };
      }),
    );
  }

  /** When a note was created: now when it is new, else when git first saw it, else what the file system says. */
  private async created(vault: Vault, path: string, before: string | null): Promise<Date> {
    if (before === null) return this.clock.now();
    const committed = await this.git?.firstCommitted(vault.diskPath(path));
    return committed ?? new Date(vault.file(path).created);
  }

  /** Runs one write or pull at a time, so two of them never race each other, in this process or across processes. */
  private serialized<T>(step: () => Promise<T>): Promise<T> {
    const locked = () => this.lock.hold(step);
    const next = this.queue.then(locked, locked);
    this.queue = next.catch(() => {});
    return next;
  }
}

/**
 * A word as Obsidian's word count sees it: a run of letters, hyphens and straight apostrophes, or a number such as
 * 3.14 or 1,000. Chinese and Japanese characters, which are written without spaces, count one word each.
 */
const WORD =
  /(?:[0-9]+(?:[,.][0-9]+)*|(?![\p{sc=Han}\u3041-\u3096\u30a0-\u30ff])[-'\p{L}])+|[\p{sc=Han}\u3041-\u3096\u30a0-\u30ff]/gu;

/** Where a new file goes: an exact path, or a name placed by the vault's new file location setting. */
export type FileTarget = { path: string } | { name: string };

/**
 * The vault's tags as the Obsidian CLI counts them: every occurrence in a note that is not excluded, with case
 * variants merged under the spelling seen first. A parent of a nested tag counts the occurrences below it.
 */
function vaultTags(vault: Vault): TagCount[] {
  const counts = new Map<string, TagCount>();
  for (const path of includedNotes(vault)) {
    for (const tag of vault.note(path).tagOccurrences) {
      const parts = tag.split("/");
      for (let depth = 1; depth <= parts.length; depth++) {
        const name = parts.slice(0, depth).join("/");
        const entry = counts.get(name.toLowerCase()) ?? { tag: name, count: 0 };
        entry.count++;
        counts.set(name.toLowerCase(), entry);
      }
    }
  }
  return [...counts.values()].sort((a, b) => compareNames(a.tag, b.tag));
}

/** Notes that are not hidden by Obsidian's excluded files setting. */
function includedNotes(vault: Vault): string[] {
  return vault.markdownPaths().filter((path) => !vault.isExcluded(path));
}

function resolveRef(vault: Vault, ref: FileRef): string {
  if ("path" in ref) {
    const path = normalize(ref.path.normalize("NFC"));
    if (path !== null && path !== "" && !vault.entry(path) && vault.folders().includes(path)) {
      throw new BackroomError("invalid_argument", `"${path}" is a folder, not a file.`);
    }
    if (path === null || !vault.entry(path)) throw fileNotFound(ref.path);
    return path;
  }
  return vault.resolveName(ref.file);
}

function resolveMarkdown(vault: Vault, ref: FileRef): string {
  const path = resolveRef(vault, ref);
  if (vault.entry(path)?.text === null) {
    throw new BackroomError("invalid_argument", `"${path}" is not a markdown note.`);
  }
  return path;
}

function textOf(vault: Vault, path: string): string {
  if (vault.entry(path)?.text === null)
    throw new BackroomError("unsupported", `"${path}" is not a text file backroom can read.`);
  return vault.text(path);
}

/** A write must not turn frontmatter Obsidian can read into frontmatter it cannot. */
function checkFrontmatterStaysReadable(before: Note, text: string, path: string) {
  const after = parseNote(text).frontmatter;
  if (before.frontmatter.kind === "valid" && after.kind === "invalid") {
    throw new BackroomError(
      "unsafe",
      `The change would make the frontmatter of "${path}" unreadable (${after.error.split("\n")[0]}).`,
    );
  }
}

function checkVersion(vault: Vault, path: string, version: string) {
  if (vault.version(path) !== version) {
    throw new BackroomError(
      "conflict",
      `File "${path}" changed since version ${version}. Read it again and retry the change.`,
    );
  }
}

function normalizeFolder(folder: string): string {
  const normalized = normalize(folder);
  if (normalized === null) throw new BackroomError("invalid_argument", `Folder "${folder}" is outside the vault.`);
  return normalized;
}

function newFilePath(vault: Vault, target: FileTarget): string {
  let path: string;
  if ("path" in target) {
    const normalized = normalize(target.path);
    if (normalized === null || normalized === "")
      throw new BackroomError("invalid_argument", `Path "${target.path}" is not a valid vault path.`);
    path = normalized;
  } else {
    if (target.name.includes("/"))
      throw new BackroomError("invalid_argument", "A name cannot contain a folder. Use path instead.");
    const folder = vault.settings.newFileLocation === "folder" ? normalizeFolder(vault.settings.newFileFolderPath) : "";
    path = join(folder, target.name);
  }
  if (extension(path) === "") path = `${path}.md`;
  if (isHidden(path))
    throw new BackroomError("invalid_argument", `Path "${path}" is in a hidden folder, which backroom does not touch.`);
  const nameError = validateFileName(stem(path));
  if (nameError) throw new BackroomError("invalid_argument", nameError);
  if (extension(path).toLowerCase() !== "md") {
    throw new BackroomError("unsupported", "backroom only creates markdown notes.");
  }
  return path;
}

/** The path with " 1", " 2" and so on added to its name until no file has it, the way Obsidian names a copy. */
function freePath(vault: Vault, path: string): string {
  const ext = extension(path);
  const base = ext === "" ? path : path.slice(0, -ext.length - 1);
  for (let number = 1; ; number++) {
    const candidate = `${base} ${number}${ext === "" ? "" : `.${ext}`}`;
    if (!vault.fileIgnoringCase(candidate)) return candidate;
  }
}

function moveDestination(vault: Vault, from: string, destination: string): string {
  const normalized = normalize(destination);
  if (normalized === null) throw new BackroomError("invalid_argument", `"${destination}" is outside the vault.`);
  const isFolder =
    normalized === "" ||
    destination.endsWith("/") ||
    vault.folders().some((folder) => folder === normalized) ||
    (extension(normalized) === "" && extension(from) !== "");
  return isFolder ? join(normalized, basename(from)) : normalized;
}

/** Plans the changes that undo a commit, refusing when a file changed since the commit. */
function planRevert(vault: Vault, commit: string, commitChanges: CommitChange[]): Change[] {
  const current = (path: string): string | null => {
    const entry = vault.entry(path);
    return entry ? (entry.text ?? null) : null;
  };
  for (const change of commitChanges) {
    if (change.path.startsWith(`${TRASH_FOLDER}/`)) continue;
    if (!isMarkdown(change.path)) {
      throw new BackroomError(
        "unsupported",
        `Commit ${commit} changed "${change.path}", and backroom only reverts notes.`,
      );
    }
    const now = vault.entry(change.path) ? current(change.path) : null;
    if (now !== change.after) {
      throw new BackroomError("conflict", `"${change.path}" changed since commit ${commit}, so it cannot be reverted.`);
    }
  }

  const visible = commitChanges.filter((change) => !change.path.startsWith(`${TRASH_FOLDER}/`));
  const trashed = commitChanges.filter(
    (change) => change.path.startsWith(`${TRASH_FOLDER}/`) && change.before === null,
  );
  const removed = visible.filter((change) => change.after === null);
  let added = visible.filter((change) => change.before === null);
  const changes: Change[] = [];

  for (const change of removed) {
    const fromTrash = trashed.find((trash) => trash.after === change.before);
    if (fromTrash) {
      changes.push({ kind: "move", from: fromTrash.path, to: change.path, baseVersion: null });
    } else if (removed.length === 1 && added.length === 1) {
      const movedTo = added[0]!;
      added = [];
      changes.push({
        kind: "move",
        from: movedTo.path,
        to: change.path,
        baseVersion: vault.version(movedTo.path),
        text: change.before!,
      });
    } else {
      changes.push({ kind: "create", path: change.path, text: change.before! });
    }
  }
  for (const change of added) {
    changes.push({ kind: "trash", path: change.path, baseVersion: vault.version(change.path) });
  }
  for (const change of visible) {
    if (change.before !== null && change.after !== null) {
      changes.push({ kind: "modify", path: change.path, baseVersion: vault.version(change.path), text: change.before });
    }
  }
  return changes;
}
