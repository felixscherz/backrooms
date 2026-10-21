import { isMap, isScalar, parseDocument, stringify, type Pair } from "yaml";
import { BackroomError } from "./errors";
import { parseNote, type Span } from "./note";
import type { PropertyType } from "./vault";

/** A property value as the caller sets it, typed the way Obsidian's property types are. */
export type PropertyValue =
  | { type: "text"; value: string }
  | { type: "list"; items: string[] }
  | { type: "number"; value: number }
  | { type: "checkbox"; value: boolean }
  | { type: "date"; value: string }
  | { type: "datetime"; value: string };

export type PropertyValueType = PropertyValue["type"];

export const propertyValueTypes: PropertyValueType[] = ["text", "list", "number", "checkbox", "date", "datetime"];

/** Parses a value given as text, as the `value=` parameter of `property:set` is. */
export function parsePropertyValue(raw: string, type: PropertyValueType): PropertyValue {
  switch (type) {
    case "text":
      return { type, value: raw };
    case "list":
      return {
        type,
        items: raw
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item !== ""),
      };
    case "number": {
      const value = Number(raw.trim());
      if (raw.trim() === "" || !Number.isFinite(value)) throw invalid(`Invalid number "${raw}".`);
      return { type, value };
    }
    case "checkbox": {
      const lower = raw.trim().toLowerCase();
      if (lower !== "true" && lower !== "false") throw invalid("Invalid checkbox value. Use true or false");
      return { type, value: lower === "true" };
    }
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) || !isValidDate(raw.trim())) {
        throw invalid("Invalid date format. Use YYYY-MM-DD");
      }
      return { type, value: raw.trim() };
    case "datetime":
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(raw.trim()) || !isValidDate(raw.trim().slice(0, 10))) {
        throw invalid("Invalid datetime format. Use YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss");
      }
      return { type, value: raw.trim() };
  }
}

function isValidDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function invalid(message: string): BackroomError {
  return new BackroomError("invalid_argument", message);
}

/** The type a value gets when the caller does not name one: the vault's known type, else the current value's. */
export function inferValueType(known: PropertyType | undefined, current: unknown): PropertyValueType {
  switch (known) {
    case "multitext":
    case "tags":
    case "aliases":
      return "list";
    case "number":
    case "checkbox":
    case "date":
    case "datetime":
    case "text":
      return known;
  }
  if (Array.isArray(current)) return "list";
  if (typeof current === "number") return "number";
  if (typeof current === "boolean") return "checkbox";
  return "text";
}

/**
 * Sets a property by rewriting only the text of its value in the frontmatter, or by adding a line for a new
 * property. Everything else in the file stays byte for byte as it was.
 */
export function setProperty(text: string, name: string, value: PropertyValue): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const frontmatter = editableFrontmatter(text);
  if (!frontmatter) {
    return `---${newline}${renderKey(name)}:${renderValue(value, newline)}${newline}---${newline}${text}`;
  }
  const pair = findPair(text, frontmatter, name);
  if (!pair) {
    const yamlEnd = frontmatter.end;
    const needsNewline = yamlEnd > frontmatter.start && text[yamlEnd - 1] !== "\n";
    const line = `${renderKey(name)}:${renderValue(value, newline)}${newline}`;
    return text.slice(0, yamlEnd) + (needsNewline ? newline : "") + line + text.slice(yamlEnd);
  }
  return text.slice(0, pair.valueSpan.start) + renderValue(value, newline) + text.slice(pair.valueSpan.end);
}

/** Removes a property's lines from the frontmatter. */
export function removeProperty(text: string, name: string): string {
  const frontmatter = editableFrontmatter(text);
  const pair = frontmatter && findPair(text, frontmatter, name);
  if (!pair) throw new BackroomError("not_found", `Property "${name}" not found.`);
  const lineStart = text.lastIndexOf("\n", pair.keyStart - 1) + 1;
  const newlineAfter = text.indexOf("\n", pair.valueSpan.end);
  const lineEnd = newlineAfter === -1 ? text.length : newlineAfter + 1;
  return text.slice(0, lineStart) + text.slice(Math.min(lineEnd, frontmatter.end));
}

/** The YAML span of the frontmatter, or null for a note without one. Refuses notes whose frontmatter is invalid. */
function editableFrontmatter(text: string): Span | null {
  const frontmatter = parseNote(text).frontmatter;
  if (frontmatter.kind === "none") return null;
  if (frontmatter.kind === "invalid") {
    throw new BackroomError(
      "unsafe",
      `The frontmatter cannot be read (${frontmatter.error.split("\n")[0]}), so properties cannot be changed safely.`,
    );
  }
  return frontmatter.yamlSpan;
}

type PairLocation = { key: string; keyStart: number; valueSpan: Span };

function findPair(text: string, yamlSpan: Span, name: string): PairLocation | null {
  const yaml = text.slice(yamlSpan.start, yamlSpan.end);
  const document = parseDocument(yaml);
  if (!isMap(document.contents)) return null;
  const pairs = document.contents.items as Pair[];
  const keyOf = (pair: Pair) => (isScalar(pair.key) ? String(pair.key.value) : null);
  const pair =
    pairs.find((item) => keyOf(item) === name) ??
    pairs.find((item) => keyOf(item)?.toLowerCase() === name.toLowerCase());
  if (!pair || !isScalar(pair.key) || !pair.key.range) return null;

  const keyEnd = pair.key.range[1];
  const colon = yaml.indexOf(":", keyEnd);
  const valueRange = (pair.value as { range?: [number, number, number] } | null)?.range;
  let valueEnd = Math.max(colon + 1, valueRange?.[1] ?? colon + 1);
  while (valueEnd > colon + 1 && /\s/.test(yaml[valueEnd - 1]!)) valueEnd--;
  return {
    key: keyOf(pair)!,
    keyStart: yamlSpan.start + pair.key.range[0],
    valueSpan: { start: yamlSpan.start + colon + 1, end: yamlSpan.start + valueEnd },
  };
}

function renderKey(name: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_ -]*$/.test(name) && name.trim() === name ? name : stringify(name).trimEnd();
}

/** The text after `key:`, including the leading space or newline. */
function renderValue(value: PropertyValue, newline: string): string {
  switch (value.type) {
    case "text":
      return ` ${renderScalar(value.value)}`;
    case "list":
      if (value.items.length === 0) return " []";
      return value.items.map((item) => `${newline}  - ${renderScalar(item)}`).join("");
    case "number":
      return ` ${value.value}`;
    case "checkbox":
      return ` ${value.value}`;
    case "date":
    case "datetime":
      return ` ${value.value}`;
  }
}

function renderScalar(value: string): string {
  if (value === "") return '""';
  return stringify(value, { lineWidth: 0 }).trimEnd();
}
