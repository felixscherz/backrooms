import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseNote } from "../src/note";

/** The vault the commands run against, opened in Obsidian under the name of its folder. */
export const VAULT = join(import.meta.dir, "..", "test-vault");
export const RECORDING = join(import.meta.dir, "obsidian.json");

/** A command from `commands.txt`. */
export type CompatCommand = {
  /** The line as written, which also keys the recording. */
  line: string;
  args: string[];
  /**
   * Marked with a leading `~ `. For reads, the order of output lines, or of a json array, is left open. For writes,
   * frontmatter is compared by its parsed properties.
   */
  unordered: boolean;
};

/** The files a write changed: their new content, or null for a file that is gone. */
export type FileChanges = Record<string, string | null>;

/** What Obsidian answered to each command, keyed by its line, and what each write did to the vault. */
export type Recording = {
  obsidian: string;
  outputs: Record<string, string>;
  writes: Record<string, { output: string; changes: FileChanges }>;
};

export function loadCommands(file: "commands.txt" | "writes.txt" = "commands.txt"): CompatCommand[] {
  return readFileSync(join(import.meta.dir, file), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const unordered = line.startsWith("~ ");
      const command = unordered ? line.slice(2) : line;
      return { line: command, args: splitShellWords(command), unordered };
    });
}

export function loadRecording(): Recording {
  return JSON.parse(readFileSync(RECORDING, "utf8"));
}

/** Splits a line into arguments like a POSIX shell: double and single quotes group, backslash escapes. */
export function splitShellWords(line: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
    } else if (char === "\\" && i + 1 < line.length && (quote === null || /["\\$`]/.test(line[i + 1]!))) {
      word = (word ?? "") + line[++i];
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= "";
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/**
 * Output in a form where the order of lines, or of a json array's items, no longer matters. Whether json is
 * printed on one line or indented still does.
 */
export function withoutOrder(output: string): string {
  try {
    const value = JSON.parse(output);
    const layout = output.trim().includes("\n") ? "indented" : "one line";
    if (Array.isArray(value)) return `${layout}: ${JSON.stringify(value.map((item) => JSON.stringify(item)).sort())}`;
  } catch {}
  return output.split("\n").sort().join("\n");
}

/**
 * Every file of a vault folder except Obsidian's settings and `.trash`, with its content. Attachments are base64.
 * `.trash` is left out because Obsidian's CLI moves deleted files to the system trash instead.
 */
export async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (folder: string) => {
    for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
      const path = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (path === ".obsidian" || path === ".trash") continue;
      if (entry.isDirectory()) await walk(path);
      else if (path.endsWith(".md")) files[path] = await readFile(join(root, path), "utf8");
      else files[path] = `base64:${(await readFile(join(root, path))).toString("base64")}`;
    }
  };
  await walk("");
  return files;
}

export function changesBetween(before: Record<string, string>, after: Record<string, string>): FileChanges {
  const changes: FileChanges = {};
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (before[path] !== after[path]) changes[path] = after[path] ?? null;
  }
  return changes;
}

/** File changes with each note's frontmatter replaced by its parsed properties, for comparing what it says. */
export function withParsedFrontmatter(changes: FileChanges): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(changes).map(([path, text]) => {
      if (text === null || !path.endsWith(".md")) return [path, text];
      const note = parseNote(text);
      const bodyStart = note.frontmatter.kind === "none" ? 0 : note.frontmatter.span.end;
      return [path, { properties: note.properties, body: text.slice(bodyStart) }];
    }),
  );
}
