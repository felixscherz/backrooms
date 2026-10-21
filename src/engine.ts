import { BackroomError, fileNotFound } from "./errors";
import {
  inferValueType,
  parsePropertyValue,
  removeProperty,
  setProperty,
  type PropertyValue,
  type PropertyValueType,
} from "./frontmatter";
import { planMove } from "./move";
import type { JsonValue, Properties } from "./note";
import { basename, compareNames, dirname, extension, isHidden, join, normalize, stem, validateFileName } from "./paths";
import { matchFile, parseQuery, type FileMatch } from "./search";
import { Vault, type VaultFile } from "./vault";
import { applyChanges, type AppliedChange, type Change } from "./write";

/** How a command names a file: `path=` is the exact vault path, `file=` resolves like a wikilink. */
export type FileRef = { path: string } | { file: string };

export type OutlineHeading = { level: number; heading: string; line: number };
export type TagCount = { tag: string; count: number };
export type OutgoingLink = { target: string; resolved: boolean };
export type Backlink = { file: string; count: number };
export type Alias = { alias: string; path: string };
export type UnresolvedLink = { link: string; count: number; sources: string[] };
export type PropertyCount = { name: string; count: number };

/** A write that was applied, described for the caller and for the commit that records it. */
export type WriteResult = { operation: string; summary: string; changes: AppliedChange[] };

export type WriteListener = (result: WriteResult) => Promise<void>;

/**
 * The vault engine. Every operation of the CLI and the MCP server exists here once. Reads load a fresh picture of
 * the vault, writes are planned against it and applied through the single write path.
 */
export class Engine {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly root: string,
    private readonly onWrite: WriteListener = async () => {},
  ) {}

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

  async properties(ref: FileRef): Promise<{ path: string; properties: Properties; yaml: string }> {
    const vault = await this.vault();
    const path = resolveMarkdown(vault, ref);
    const note = vault.note(path);
    const text = vault.text(path);
    const yaml =
      note.frontmatter.kind === "valid"
        ? text.slice(note.frontmatter.yamlSpan.start, note.frontmatter.yamlSpan.end)
        : "";
    return { path, properties: note.properties, yaml };
  }

  async propertyNames(): Promise<PropertyCount[]> {
    const vault = await this.vault();
    const counts = new Map<string, number>();
    for (const path of vault.markdownPaths()) {
      for (const name of Object.keys(vault.note(path).properties)) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => compareNames(a.name, b.name));
  }

  async propertyRead(ref: FileRef, name: string): Promise<JsonValue> {
    const vault = await this.vault();
    const path = resolveMarkdown(vault, ref);
    const properties = vault.note(path).properties;
    if (!(name in properties)) throw new BackroomError("not_found", `Property "${name}" not found in "${path}".`);
    return properties[name]!;
  }

  async tagsOf(ref: FileRef): Promise<string[]> {
    const vault = await this.vault();
    return vault.note(resolveMarkdown(vault, ref)).tags;
  }

  /**
   * Every tag in the vault with the number of notes that carry it. Like the Obsidian CLI, the list includes each
   * parent of a nested tag, counted once for every tag below it, and leaves out excluded files.
   */
  async tags(): Promise<TagCount[]> {
    const vault = await this.vault();
    const counts = new Map<string, TagCount>();
    const count = (tag: string) => {
      const entry = counts.get(tag.toLowerCase()) ?? { tag, count: 0 };
      entry.count++;
      counts.set(tag.toLowerCase(), entry);
    };
    for (const path of includedNotes(vault)) {
      for (const tag of vault.note(path).tags) {
        const parts = tag.split("/");
        for (let depth = 1; depth <= parts.length; depth++) count(parts.slice(0, depth).join("/"));
      }
    }
    return [...counts.values()].sort((a, b) => compareNames(a.tag, b.tag));
  }

  /** The notes that carry a tag or a tag nested below it, leaving out excluded files. */
  async tag(name: string): Promise<{ tag: string; files: string[] }> {
    const vault = await this.vault();
    const wanted = name.replace(/^#/, "").toLowerCase();
    const files = includedNotes(vault).filter((path) =>
      vault.note(path).tags.some((tag) => tag.toLowerCase() === wanted || tag.toLowerCase().startsWith(`${wanted}/`)),
    );
    return { tag: name.replace(/^#/, ""), files };
  }

  async aliases(ref?: FileRef): Promise<Alias[]> {
    const vault = await this.vault();
    const paths = ref ? [resolveMarkdown(vault, ref)] : vault.markdownPaths();
    return paths.flatMap((path) => vault.note(path).aliases.map((alias) => ({ alias, path })));
  }

  // Links

  /** The distinct files a note links to, and the link paths that resolve to no file. */
  async links(ref: FileRef): Promise<OutgoingLink[]> {
    const vault = await this.vault();
    const path = resolveMarkdown(vault, ref);
    const seen = new Map<string, OutgoingLink>();
    for (const { link, target } of vault.outgoing(path)) {
      if (target === path && link.target === "") continue;
      const entry = target === null ? { target: link.target, resolved: false } : { target, resolved: true };
      seen.set(`${entry.resolved}:${entry.target.toLowerCase()}`, entry);
    }
    return [...seen.values()].sort((a, b) => compareNames(a.target, b.target));
  }

  async backlinks(ref: FileRef): Promise<Backlink[]> {
    const vault = await this.vault();
    const path = resolveRef(vault, ref);
    return [...vault.backlinks(path)]
      .filter(([source]) => source !== path)
      .map(([file, links]) => ({ file, count: links.length }))
      .sort((a, b) => compareNames(a.file, b.file));
  }

  async unresolved(): Promise<UnresolvedLink[]> {
    const vault = await this.vault();
    const result = new Map<string, UnresolvedLink>();
    for (const [source, links] of vault.allResolvedLinks()) {
      for (const { link, target } of links) {
        if (target !== null || link.target === "") continue;
        const entry = result.get(link.target) ?? { link: link.target, count: 0, sources: [] };
        entry.count++;
        if (!entry.sources.includes(source)) entry.sources.push(source);
        result.set(link.target, entry);
      }
    }
    return [...result.values()].sort((a, b) => compareNames(a.link, b.link));
  }

  /** Files that no other note links to. Only notes unless `all` is set. */
  async orphans(all: boolean): Promise<string[]> {
    const vault = await this.vault();
    const linked = new Set<string>();
    for (const [source, links] of vault.allResolvedLinks()) {
      for (const { target } of links) if (target !== null && target !== source) linked.add(target);
    }
    const candidates = all ? vault.files().map((file) => file.path) : vault.markdownPaths();
    return candidates.filter((path) => !linked.has(path));
  }

  /** Notes without outgoing links. */
  async deadends(): Promise<string[]> {
    const vault = await this.vault();
    return vault.markdownPaths().filter((path) => vault.note(path).links.length === 0);
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

  async folders(options: { folder?: string }): Promise<string[]> {
    const vault = await this.vault();
    const folder = options.folder === undefined ? "" : normalizeFolder(options.folder);
    return vault.folders().filter((path) => folder === "" || path.startsWith(`${folder}/`));
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
    return { words: body.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length, characters: body.length };
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
   * Creates a note. An existing file is only replaced with `overwrite`, and then only when `version` names the
   * version the new content is based on.
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
      if (existing) {
        if (!options.overwrite) throw new BackroomError("already_exists", `File "${existing.path}" already exists.`);
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
        };
      }
      return {
        operation: "create",
        summary: `Created: ${path}`,
        changes: [{ kind: "create", path, text: options.content }],
      };
    });
  }

  /** Adds content at the end of a note, on a new line unless `inline`. */
  async append(
    ref: FileRef,
    content: string,
    options: { inline?: boolean; version?: string } = {},
  ): Promise<WriteResult> {
    return this.modify(ref, "append", options.version, (text, path) => {
      const separator = options.inline || text === "" || text.endsWith("\n") ? "" : "\n";
      const trailing = !options.inline && text.endsWith("\n") && !content.endsWith("\n") ? "\n" : "";
      return { text: text + separator + content + trailing, summary: `Appended to: ${path}` };
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
      summary: `Removed ${name} from: ${path}`,
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
      const changes: Change[] =
        text === vault.text(path) ? [] : [{ kind: "modify", path, baseVersion: vault.version(path), text }];
      return { operation, summary, changes };
    });
  }

  /** Runs one write at a time, so two writes from this process never race each other. */
  private async write(
    plan: (vault: Vault) => Promise<{ operation: string; summary: string; changes: Change[] }>,
  ): Promise<WriteResult> {
    const run = async () => {
      const planned = await plan(await this.vault());
      const changes = await applyChanges(this.root, planned.changes);
      const result = { ...planned, changes };
      if (changes.length > 0) await this.onWrite(result);
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }
}

/** Where a new file goes: an exact path, or a name placed by the vault's new file location setting. */
export type FileTarget = { path: string } | { name: string };

/** Notes that are not hidden by Obsidian's excluded files setting. */
function includedNotes(vault: Vault): string[] {
  return vault.markdownPaths().filter((path) => !vault.isExcluded(path));
}

function resolveRef(vault: Vault, ref: FileRef): string {
  if ("path" in ref) {
    const path = normalize(ref.path);
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
