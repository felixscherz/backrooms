import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The vault the commands run against, opened in Obsidian under the name of its folder. */
export const VAULT = join(import.meta.dir, "..", "test-vault");
export const RECORDING = join(import.meta.dir, "obsidian.json");

/** A command from `commands.txt`. */
export type CompatCommand = {
  /** The line as written, which also keys the recording. */
  line: string;
  args: string[];
  /** Whether the order of output lines, or of a json array, is left open. */
  unordered: boolean;
};

/** What Obsidian answered to each command, keyed by its line. */
export type Recording = { obsidian: string; outputs: Record<string, string> };

export function loadCommands(): CompatCommand[] {
  return readFileSync(join(import.meta.dir, "commands.txt"), "utf8")
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
