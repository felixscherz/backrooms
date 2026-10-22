import type { Clock } from "./clock";
import { DateFormat } from "./date-format";
import { BackroomsError } from "./errors";
import { parseNote } from "./note";
import type { Plugin, PluginDefinition, SavedNote } from "./plugins";

/**
 * The Linter community plugin (`obsidian-linter`), as far as backrooms reimplements it. Only the `yaml-timestamp`
 * rule is supported: it records when a note was created and last modified in its frontmatter.
 */
export const linter: PluginDefinition = {
  id: "obsidian-linter",
  load(data) {
    const general = generalSettings(data);
    const config = ruleConfig(data, "yaml-timestamp");
    // A write through backrooms stands for editing a note in Obsidian. The Linter changes a note after an edit when
    // it lints on save, when the note is left, or, for this rule alone, when the note's content changes.
    const runs =
      general.lintOnSave ||
      general.lintOnFileChange ||
      (config?.["update-on-file-contents-updated"] ?? "never") !== "never";
    return new Linter(general, runs ? timestampSettings(config) : null);
  },
};

/** The Linter's general settings that decide which notes it lints. */
type GeneralSettings = {
  lintOnSave: boolean;
  lintOnFileChange: boolean;
  foldersToIgnore: string[];
  filesToIgnore: RegExp[];
};

type TimestampSettings = {
  /** The key of the creation date, or null when the rule does not record it. */
  createdKey: string | null;
  modifiedKey: string | null;
  /** Whether date modified only changes when the Linter changes the note, not on every edit. */
  modifiedOnLinterEdits: boolean;
  format: DateFormat;
  utc: boolean;
};

class Linter implements Plugin {
  constructor(
    private readonly general: GeneralSettings,
    private readonly timestamps: TimestampSettings | null,
  ) {}

  async onSave(note: SavedNote, clock: Clock): Promise<string> {
    if (!this.timestamps || !this.lints(note.path)) return note.text;
    return recordTimestamps(note, this.timestamps, clock);
  }

  /** Whether the Linter lints the note at the path, which it does unless the path is in its folders or files to ignore. */
  private lints(path: string): boolean {
    if (this.general.foldersToIgnore.some((folder) => path.startsWith(`${folder}/`))) return false;
    return !this.general.filesToIgnore.some((pattern) => pattern.test(path));
  }
}

/**
 * The Linter's `yaml-timestamp` rule with the file system as the source of truth for the creation date. A missing,
 * empty or malformed creation date becomes the date the note was created, a valid one stays. The modification date
 * becomes now, since the note is being saved with a change. When it follows user or Linter edits instead, a valid
 * one only changes when the rule changed the note. Missing keys are added at the end of the frontmatter, which is
 * added when the note has none. Each timestamp only changes its own line.
 */
async function recordTimestamps(note: SavedNote, settings: TimestampSettings, clock: Clock): Promise<string> {
  let text = note.text;
  const frontmatter = parseNote(text).frontmatter;
  if (frontmatter.kind === "invalid") return text;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  if (frontmatter.kind === "none") text = `---${newline}---${newline}${text}`;
  const unchanged = text;
  const timeZone = settings.utc ? "UTC" : clock.timeZone;
  const write = (date: Date) => settings.format.format(date, timeZone);

  if (settings.createdKey !== null) {
    const created = findTimestamp(text, settings.createdKey);
    if (created === null || !settings.format.matches(created.value)) {
      text = setTimestamp(text, settings.createdKey, created, write(await note.created()), newline);
    }
  }
  if (settings.modifiedKey !== null) {
    const modified = findTimestamp(text, settings.modifiedKey);
    const keep =
      settings.modifiedOnLinterEdits &&
      text === unchanged &&
      modified !== null &&
      settings.format.matches(modified.value);
    if (!keep) text = setTimestamp(text, settings.modifiedKey, modified, write(clock.now()), newline);
  }
  return text;
}

type Timestamp = { start: number; end: number; value: string };

/** The line of a timestamp in the frontmatter, found the way the Linter finds it: `key: value` or `key:` alone. */
function findTimestamp(text: string, key: string): Timestamp | null {
  const frontmatter = parseNote(text).frontmatter;
  if (frontmatter.kind === "none") return null;
  const yaml = text.slice(frontmatter.yamlSpan.start, frontmatter.yamlSpan.end);
  const match = new RegExp(`^${escapeRegex(key)}:(?: ([^\\r\\n]+)|[ \\t]*)(?=\\r?$)`, "m").exec(yaml);
  if (!match) return null;
  const start = frontmatter.yamlSpan.start + match.index;
  return { start, end: start + match[0].length, value: (match[1] ?? "").trim() };
}

function setTimestamp(text: string, key: string, current: Timestamp | null, value: string, newline: string): string {
  const line = `${key}: ${value}`;
  if (current) return text.slice(0, current.start) + line + text.slice(current.end);
  const end = parseNote(text).frontmatter;
  if (end.kind === "none") return text;
  return text.slice(0, end.yamlSpan.end) + line + newline + text.slice(end.yamlSpan.end);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Settings, read from the Linter's data.json with the Linter's defaults

function ruleConfig(data: unknown, rule: string): Record<string, unknown> | null {
  const configs = isRecord(data) ? data.ruleConfigs : undefined;
  const config = isRecord(configs) ? configs[rule] : undefined;
  return isRecord(config) && config.enabled === true ? config : null;
}

function timestampSettings(config: Record<string, unknown> | null): TimestampSettings | null {
  if (!config) return null;
  const option = <T>(key: string, fallback: T): T =>
    typeof config[key] === typeof fallback ? (config[key] as T) : fallback;
  const pattern = option("format", "dddd, MMMM Do YYYY, h:mm:ss a").trimEnd();
  const format = DateFormat.parse(pattern);
  if (!format) {
    throw unsupported(
      `its date format "${pattern}" uses tokens backrooms does not support. backrooms supports numeric tokens such as YYYY-MM-DD HH:mm:ss`,
    );
  }
  const createdTruth = option("date-created-source-of-truth", "file system");
  if (option("date-created", true) && createdTruth !== "file system") {
    throw unsupported(`it takes the creation date from the ${createdTruth}. backrooms only supports the file system`);
  }
  return {
    createdKey: option("date-created", true) ? option("date-created-key", "date created") : null,
    modifiedKey: option("date-modified", true) ? option("date-modified-key", "date modified") : null,
    modifiedOnLinterEdits: option<string>("date-modified-source-of-truth", "file system") === "user or Linter edits",
    format,
    utc: option("convert-to-utc", false),
  };
}

function generalSettings(data: unknown): GeneralSettings {
  const settings = isRecord(data) ? data : {};
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
  return {
    lintOnSave: settings.lintOnSave === true,
    lintOnFileChange: settings.lintOnFileChange === true,
    foldersToIgnore: strings(settings.foldersToIgnore)
      .filter((folder) => folder.length > 0)
      .map(normalizePath),
    filesToIgnore: (Array.isArray(settings.filesToIgnore) ? settings.filesToIgnore : [])
      .filter((file): file is { match: string; flags?: unknown } => isRecord(file) && typeof file.match === "string")
      .filter((file) => file.match !== "")
      .map((file) => fileToIgnore(file.match, typeof file.flags === "string" ? file.flags : "")),
  };
}

function fileToIgnore(match: string, flags: string): RegExp {
  try {
    return new RegExp(match, flags);
  } catch {
    throw new BackroomsError(
      "unsafe",
      `backrooms cannot tell which notes the Linter ignores, because "${match}" with flags "${flags}" in its files to ignore is not a valid regular expression.`,
    );
  }
}

/** A folder path as Obsidian's `normalizePath` writes it. */
function normalizePath(path: string): string {
  const normalized = path.replace(/([\\/])+/g, "/").replace(/(^\/+|\/+$)/g, "");
  return (normalized === "" ? "/" : normalized).replace(/\u00A0|\u202F/g, " ").normalize("NFC");
}

function unsupported(reason: string): BackroomsError {
  return new BackroomsError(
    "unsafe",
    `backrooms cannot save notes the way the Linter's yaml-timestamp rule is set up, because ${reason}.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
