import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "./clock";
import { BackroomsError } from "./errors";
import { linter } from "./linter";

/** A note that a write saves, as a plugin sees it. */
export type SavedNote = {
  path: string;
  /** The text before the write, or null when the write creates the note. */
  before: string | null;
  /** The text the write saves. */
  text: string;
  /** When the note was created: now for a new note, else when git first saw it, else the file system's date. */
  created(): Promise<Date>;
};

/** A feature of an Obsidian community plugin, reimplemented in backrooms (ADR 7). */
export type Plugin = {
  /** The text to save instead, after doing what the Obsidian plugin does when the note is saved. */
  onSave(note: SavedNote, clock: Clock): Promise<string>;
};

export type PluginDefinition = {
  /** The id of the Obsidian plugin, as in `.obsidian/community-plugins.json`. */
  id: string;
  /** Sets the plugin up from the Obsidian plugin's `data.json`, or fails when backrooms cannot follow its settings. */
  load(data: unknown): Plugin;
};

const PLUGINS: PluginDefinition[] = [linter];

/** The plugins the vault enables, set up from their settings in `.obsidian/plugins/<id>/data.json`. */
export async function loadPlugins(root: string, enabled: string[]): Promise<Plugin[]> {
  const plugins: Plugin[] = [];
  for (const definition of PLUGINS) {
    if (!enabled.includes(definition.id)) continue;
    plugins.push(definition.load(await readData(root, definition.id)));
  }
  return plugins;
}

async function readData(root: string, id: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(join(root, ".obsidian", "plugins", id, "data.json"), "utf8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BackroomsError(
      "unsafe",
      `The settings of the plugin ${id} in .obsidian/plugins/${id}/data.json are not valid JSON.`,
    );
  }
}
