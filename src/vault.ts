import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join as joinFs } from "node:path";
import { parseNote, type Link, type Note } from "./note";
import { basename, compareNames, dirname, isMarkdown, join, normalize } from "./paths";
import { fileNotFound } from "./errors";

export type VaultFile = {
  path: string;
  size: number;
  /** Milliseconds since the epoch. */
  created: number;
  modified: number;
};

export type LinkFormat = "shortest" | "relative" | "absolute";
export type PropertyType = "text" | "multitext" | "number" | "checkbox" | "date" | "datetime" | "aliases" | "tags";

/** The parts of the vault's Obsidian settings that change how backroom reads or writes it. */
export type Settings = {
  newLinkFormat: LinkFormat;
  useMarkdownLinks: boolean;
  newFileLocation: "root" | "current" | "folder";
  newFileFolderPath: string;
  /** Excluded files, as Obsidian stores them: path prefixes or `/regex/`. */
  userIgnoreFilters: string[];
  /** Property types from `.obsidian/types.json`. */
  propertyTypes: Record<string, PropertyType>;
  /** Ids of the community plugins enabled in `.obsidian/community-plugins.json`. */
  enabledPlugins: string[];
};

export const defaultSettings: Settings = {
  newLinkFormat: "shortest",
  useMarkdownLinks: false,
  newFileLocation: "root",
  newFileFolderPath: "",
  userIgnoreFilters: [],
  propertyTypes: {},
  enabledPlugins: [],
};

/**
 * A file of the vault as the engine sees it. Markdown files carry their text. `path` is in Unicode NFC, as Obsidian
 * shows paths, and `diskPath` is the name on disk when that is stored differently, for example decomposed on macOS.
 */
export type Entry = VaultFile & { text: string | null; diskPath?: string };

export type ResolvedLink = { link: Link; target: string | null };

/**
 * An immutable picture of a vault: its files, the parsed notes and how their links resolve. Every operation reads
 * from one, and planned writes are checked against a new one built from the result.
 */
export class Vault {
  private readonly entries: Map<string, Entry>;
  private readonly byLowerPath = new Map<string, Entry>();
  private readonly byLowerName = new Map<string, Entry[]>();
  private readonly notes = new Map<string, Note>();
  private resolvedLinks: Map<string, ResolvedLink[]> | null = null;

  private constructor(
    readonly root: string | null,
    readonly settings: Settings,
    entries: Iterable<Entry>,
  ) {
    this.entries = new Map([...entries].map((entry) => [entry.path, entry]));
    for (const entry of this.entries.values()) {
      this.byLowerPath.set(entry.path.toLowerCase(), entry);
      const name = basename(entry.path).toLowerCase();
      this.byLowerName.set(name, [...(this.byLowerName.get(name) ?? []), entry]);
    }
  }

  static async load(root: string): Promise<Vault> {
    const settings = await loadSettings(root);
    const entries: Entry[] = [];
    const walk = async (folder: string) => {
      for (const dirent of await readdir(joinFs(root, folder), { withFileTypes: true })) {
        if (dirent.name.startsWith(".")) continue;
        const diskPath = join(folder, dirent.name);
        if (dirent.isDirectory()) {
          await walk(diskPath);
        } else if (dirent.isFile()) {
          const absolute = joinFs(root, diskPath);
          const stats = await stat(absolute);
          const path = diskPath.normalize("NFC");
          entries.push({
            path,
            ...(path === diskPath ? {} : { diskPath }),
            size: stats.size,
            created: stats.birthtimeMs || stats.ctimeMs,
            modified: stats.mtimeMs,
            text: isMarkdown(path) ? await readFile(absolute, "utf8") : null,
          });
        }
      }
    };
    await walk("");
    return new Vault(root, settings, entries);
  }

  /** Builds a vault from files in memory, for planning writes and for tests. */
  static fromFiles(
    files: Iterable<{ path: string; text?: string | null; created?: number; modified?: number; size?: number }>,
    settings: Partial<Settings> = {},
    root: string | null = null,
  ): Vault {
    const entries = [...files].map(
      (file): Entry => ({
        path: file.path,
        text: isMarkdown(file.path) ? (file.text ?? "") : null,
        size: file.size ?? Buffer.byteLength(file.text ?? ""),
        created: file.created ?? 0,
        modified: file.modified ?? 0,
      }),
    );
    return new Vault(root, { ...defaultSettings, ...settings }, entries);
  }

  /** A new vault with some files replaced, added or removed. */
  withChanges(changed: Iterable<Entry>, removed: Iterable<string>): Vault {
    const entries = new Map(this.entries);
    for (const path of removed) entries.delete(path);
    for (const entry of changed) entries.set(entry.path, entry);
    return new Vault(this.root, this.settings, entries.values());
  }

  files(): VaultFile[] {
    return [...this.entries.values()]
      .map(({ text, diskPath, ...file }) => file)
      .sort((a, b) => compareNames(a.path, b.path));
  }

  folders(): string[] {
    const folders = new Set<string>();
    for (const path of this.entries.keys()) {
      for (let folder = dirname(path); folder !== ""; folder = dirname(folder)) folders.add(folder);
    }
    return [...folders].sort(compareNames);
  }

  markdownPaths(): string[] {
    return [...this.entries.values()]
      .filter((entry) => entry.text !== null)
      .map((entry) => entry.path)
      .sort(compareNames);
  }

  entry(path: string): Entry | undefined {
    return this.entries.get(path);
  }

  /** Looks a file up by its exact path, the way the `path=` parameter does. */
  file(path: string): VaultFile {
    const entry = this.entries.get(path);
    if (!entry) throw fileNotFound(path);
    const { text, diskPath, ...file } = entry;
    return file;
  }

  /** Where a vault path is stored on disk, which differs from the path when the name is not stored in NFC. */
  diskPath(path: string): string {
    return this.entries.get(path)?.diskPath ?? path;
  }

  /** Looks a file up by path ignoring case, the way Obsidian matches link paths. */
  fileIgnoringCase(path: string): Entry | undefined {
    return this.byLowerPath.get(path.toLowerCase());
  }

  /** Files with the given file name (including extension), ignoring case. */
  filesNamed(name: string): Entry[] {
    return this.byLowerName.get(name.toLowerCase()) ?? [];
  }

  text(path: string): string {
    const entry = this.entries.get(path);
    if (entry?.text === undefined || entry.text === null) throw fileNotFound(path);
    return entry.text;
  }

  note(path: string): Note {
    let note = this.notes.get(path);
    if (!note) {
      note = parseNote(this.text(path));
      this.notes.set(path, note);
    }
    return note;
  }

  /** The version of a markdown file that writes are checked against. */
  version(path: string): string {
    return contentVersion(this.text(path));
  }

  /**
   * Finds the file a link path points to from a source note, the way Obsidian does: an exact path first, then the
   * same path relative to the source, then any file whose path ends with the link path, preferring the source's
   * folder and then the shortest path.
   */
  resolve(linkpath: string, sourcePath: string): string | null {
    if (linkpath === "") return this.entries.has(sourcePath) ? sourcePath : null;
    linkpath = linkpath.normalize("NFC");
    const sourceFolder = dirname(sourcePath);
    if (linkpath.startsWith("./") || linkpath.startsWith("../")) {
      const path = normalize(join(sourceFolder, linkpath));
      return path === null ? null : this.exact(path);
    }
    const path = linkpath.replace(/^\/+/, "");
    const direct = this.exact(path) ?? (sourceFolder === "" ? null : this.exact(join(sourceFolder, path)));
    if (direct) return direct;

    const lower = path.toLowerCase();
    const name = basename(lower);
    const candidates = [...this.filesNamed(name), ...this.filesNamed(`${name}.md`)].filter((entry) => {
      const candidate = entry.path.toLowerCase();
      return [lower, `${lower}.md`].some((suffix) => candidate === suffix || candidate.endsWith(`/${suffix}`));
    });
    candidates.sort(
      (a, b) =>
        Number(dirname(b.path) === sourceFolder) - Number(dirname(a.path) === sourceFolder) ||
        a.path.length - b.path.length ||
        compareNames(a.path, b.path),
    );
    return candidates[0]?.path ?? null;
  }

  private exact(path: string): string | null {
    return (this.byLowerPath.get(path.toLowerCase()) ?? this.byLowerPath.get(`${path.toLowerCase()}.md`))?.path ?? null;
  }

  /** Looks a file up by name the way the `file=` parameter does, which resolves like a wikilink. */
  resolveName(name: string): string {
    const path = this.resolve(name, "");
    if (!path) throw fileNotFound(name);
    return path;
  }

  /** The links of a note with the file each one resolves to. */
  outgoing(path: string): ResolvedLink[] {
    this.text(path);
    return this.allResolvedLinks().get(path) ?? [];
  }

  /** Every note that links to the file, with the links that do. */
  backlinks(path: string): Map<string, Link[]> {
    const result = new Map<string, Link[]>();
    for (const [source, links] of this.allResolvedLinks()) {
      const matching = links.filter((resolved) => resolved.target === path).map((resolved) => resolved.link);
      if (matching.length > 0) result.set(source, matching);
    }
    return result;
  }

  allResolvedLinks(): Map<string, ResolvedLink[]> {
    if (!this.resolvedLinks) {
      this.resolvedLinks = new Map(
        this.markdownPaths().map((source) => [
          source,
          this.note(source).links.map((link) => ({ link, target: this.resolve(link.target, source) })),
        ]),
      );
    }
    return this.resolvedLinks;
  }

  /** Whether Obsidian's excluded files setting hides the file. Path prefixes match ignoring case, like in Obsidian. */
  isExcluded(path: string): boolean {
    return this.settings.userIgnoreFilters.some((filter) => {
      if (filter.length > 2 && filter.startsWith("/") && filter.endsWith("/")) {
        try {
          return new RegExp(filter.slice(1, -1)).test(path);
        } catch {
          return false;
        }
      }
      return path.toLowerCase().startsWith(filter.toLowerCase());
    });
  }
}

export function contentVersion(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

async function loadSettings(root: string): Promise<Settings> {
  const app = await readJson(joinFs(root, ".obsidian", "app.json"));
  const types = await readJson(joinFs(root, ".obsidian", "types.json"));
  const plugins = await readJsonValue(joinFs(root, ".obsidian", "community-plugins.json"));
  const settings: Settings = { ...defaultSettings };
  if (app) {
    if (["shortest", "relative", "absolute"].includes(app.newLinkFormat as string)) {
      settings.newLinkFormat = app.newLinkFormat as LinkFormat;
    }
    if (typeof app.useMarkdownLinks === "boolean") settings.useMarkdownLinks = app.useMarkdownLinks;
    if (["root", "current", "folder"].includes(app.newFileLocation as string)) {
      settings.newFileLocation = app.newFileLocation as Settings["newFileLocation"];
    }
    if (typeof app.newFileFolderPath === "string") settings.newFileFolderPath = app.newFileFolderPath;
    if (Array.isArray(app.userIgnoreFilters)) {
      settings.userIgnoreFilters = app.userIgnoreFilters.filter(
        (filter): filter is string => typeof filter === "string",
      );
    }
  }
  const typeMap = types?.types;
  if (typeMap && typeof typeMap === "object" && !Array.isArray(typeMap)) {
    settings.propertyTypes = Object.fromEntries(
      Object.entries(typeMap).filter((pair): pair is [string, PropertyType] => typeof pair[1] === "string"),
    );
  }
  if (Array.isArray(plugins)) settings.enabledPlugins = plugins.filter((id): id is string => typeof id === "string");
  return settings;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const value = await readJsonValue(path);
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function readJsonValue(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
