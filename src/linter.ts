import type { Clock } from "./clock";
import { DateFormat } from "./date-format";
import { BackroomError } from "./errors";
import { parseNote } from "./note";
import type { Plugin, PluginDefinition, SavedNote } from "./plugins";

/**
 * The Linter community plugin (`obsidian-linter`), as far as backroom reimplements it. Only the `yaml-timestamp`
 * rule is supported: it records when a note was created and last modified in its frontmatter.
 */
export const linter: PluginDefinition = {
  id: "obsidian-linter",
  load(data) {
    const timestamps = timestampSettings(ruleConfig(data, "yaml-timestamp"));
    return new Linter(timestamps);
  },
};

type TimestampSettings = {
  /** The key of the creation date, or null when the rule does not record it. */
  createdKey: string | null;
  modifiedKey: string | null;
  format: DateFormat;
  utc: boolean;
};

class Linter implements Plugin {
  constructor(private readonly timestamps: TimestampSettings | null) {}

  async onSave(note: SavedNote, clock: Clock): Promise<string> {
    return this.timestamps ? recordTimestamps(note, this.timestamps, clock) : note.text;
  }
}

/**
 * The Linter's `yaml-timestamp` rule with the file system as the source of truth. A missing, empty or malformed
 * creation date becomes the date the note was created, a valid one stays. The modification date becomes now, since
 * the note is being saved with a change. Missing keys are added at the end of the frontmatter, which is added when
 * the note has none. Each timestamp only changes its own line.
 */
async function recordTimestamps(note: SavedNote, settings: TimestampSettings, clock: Clock): Promise<string> {
  let text = note.text;
  const frontmatter = parseNote(text).frontmatter;
  if (frontmatter.kind === "invalid") return text;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  if (frontmatter.kind === "none") text = `---${newline}---${newline}${text}`;
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
    text = setTimestamp(text, settings.modifiedKey, modified, write(clock.now()), newline);
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
      `its date format "${pattern}" uses tokens backroom does not support. backroom supports numeric tokens such as YYYY-MM-DD HH:mm:ss`,
    );
  }
  const createdTruth = option("date-created-source-of-truth", "file system");
  if (option("date-created", true) && createdTruth !== "file system") {
    throw unsupported(`it takes the creation date from the ${createdTruth}. backroom only supports the file system`);
  }
  return {
    createdKey: option("date-created", true) ? option("date-created-key", "date created") : null,
    modifiedKey: option("date-modified", true) ? option("date-modified-key", "date modified") : null,
    format,
    utc: option("convert-to-utc", false),
  };
}

function unsupported(reason: string): BackroomError {
  return new BackroomError(
    "unsafe",
    `backroom cannot save notes the way the Linter's yaml-timestamp rule is set up, because ${reason}.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
