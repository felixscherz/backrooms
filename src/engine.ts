import { BackroomError, fileNotFound } from "./errors";
import type { JsonValue, Properties } from "./note";
import { basename, compareNames, extension, normalize } from "./paths";
import { matchFile, parseQuery, type FileMatch } from "./search";
import { Vault, type VaultFile } from "./vault";

/** How a command names a file: `path=` is the exact vault path, `file=` resolves like a wikilink. */
export type FileRef = { path: string } | { file: string };

export type OutlineHeading = { level: number; heading: string; line: number };
export type TagCount = { tag: string; count: number };
export type OutgoingLink = { target: string; resolved: boolean };
export type Backlink = { file: string; count: number };
export type Alias = { alias: string; path: string };
export type UnresolvedLink = { link: string; count: number; sources: string[] };
export type PropertyCount = { name: string; count: number };

/**
 * The vault engine. Every operation of the CLI and the MCP server exists here once. Each operation loads a fresh
 * picture of the vault.
 */
export class Engine {
  constructor(readonly root: string) {}

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

  /** Every tag in the vault with the number of notes that carry it. */
  async tags(): Promise<TagCount[]> {
    const vault = await this.vault();
    const counts = new Map<string, TagCount>();
    for (const path of vault.markdownPaths()) {
      for (const tag of vault.note(path).tags) {
        const entry = counts.get(tag.toLowerCase()) ?? { tag, count: 0 };
        entry.count++;
        counts.set(tag.toLowerCase(), entry);
      }
    }
    return [...counts.values()].sort((a, b) => compareNames(a.tag, b.tag));
  }

  /** The notes that carry a tag. */
  async tag(name: string): Promise<{ tag: string; files: string[] }> {
    const vault = await this.vault();
    const wanted = name.replace(/^#/, "").toLowerCase();
    const files = vault
      .markdownPaths()
      .filter((path) => vault.note(path).tags.some((tag) => tag.toLowerCase() === wanted));
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
    for (const path of vault.markdownPaths()) {
      if (folder !== "" && !path.startsWith(`${folder}/`)) continue;
      if (vault.isExcluded(path)) continue;
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

function normalizeFolder(folder: string): string {
  const normalized = normalize(folder);
  if (normalized === null) throw new BackroomError("invalid_argument", `Folder "${folder}" is outside the vault.`);
  return normalized;
}
