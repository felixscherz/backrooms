import { BackroomsError } from "./errors";
import {
  inferValueType,
  parsePropertyValue,
  removeProperty,
  setProperty,
  type PropertyValue,
  type PropertyValueType,
} from "./frontmatter";
import { parseNote } from "./note";
import type { PropertyType } from "./vault";

/** A property value as an agent gives it: lists, numbers and booleans keep their type, text is parsed by type. */
export type PropertyInput = string | number | boolean | string[];

/** One change of the `edit` operation, applied to the text the change before it left. */
export type NoteChange =
  | { op: "replace"; old: string; new: string; all?: boolean }
  | { op: "append"; content: string }
  | { op: "prepend"; content: string }
  | { op: "set_property"; name: string; value: PropertyInput; type?: PropertyValueType }
  | { op: "remove_property"; name: string };

/**
 * Applies changes to a note's text in order. Fails on the first change that cannot apply, naming it, so either all
 * changes apply or none.
 */
export function applyNoteChanges(
  text: string,
  changes: NoteChange[],
  propertyTypes: Record<string, PropertyType>,
): string {
  return changes.reduce((current, change, index) => {
    try {
      return applyNoteChange(current, change, propertyTypes);
    } catch (error) {
      if (!(error instanceof BackroomsError) || changes.length === 1) throw error;
      throw new BackroomsError(error.code, `Change ${index + 1} (${change.op}): ${error.message} Nothing was changed.`);
    }
  }, text);
}

function applyNoteChange(text: string, change: NoteChange, propertyTypes: Record<string, PropertyType>): string {
  switch (change.op) {
    case "replace":
      return replace(text, change.old, change.new, change.all ?? false);
    case "append": {
      // Unlike the CLI's append, which follows Obsidian, the content starts on its own line but no empty one.
      const separator = text === "" || text.endsWith("\n") ? "" : "\n";
      return text + separator + change.content;
    }
    case "prepend": {
      const frontmatter = parseNote(text).frontmatter;
      const at = frontmatter.kind === "none" ? 0 : frontmatter.span.end;
      const separator = change.content.endsWith("\n") ? "" : "\n";
      return text.slice(0, at) + change.content + separator + text.slice(at);
    }
    case "set_property": {
      if (change.name.trim() === "") throw new BackroomsError("invalid_argument", "Property name must not be empty.");
      const current = parseNote(text).properties[change.name];
      return setProperty(text, change.name, propertyValue(change, propertyTypes[change.name], current));
    }
    case "remove_property":
      return removeProperty(text, change.name);
  }
}

/** Replaces text that occurs exactly once, or every occurrence with `all`, so a change never lands by surprise. */
function replace(text: string, oldText: string, newText: string, all: boolean): string {
  if (oldText === "") throw new BackroomsError("invalid_argument", "The text to replace must not be empty.");
  const parts = text.split(oldText);
  const count = parts.length - 1;
  if (count === 0) throw new BackroomsError("not_found", "The text to replace was not found.");
  if (count > 1 && !all) {
    const lines: number[] = [];
    let offset = 0;
    for (const part of parts.slice(0, -1)) {
      offset += part.length;
      lines.push(text.slice(0, offset).split("\n").length);
      offset += oldText.length;
    }
    throw new BackroomsError(
      "invalid_argument",
      `The text to replace occurs ${count} times, at lines ${lines.join(", ")}. ` +
        "Include surrounding text to make it unique, or set all to replace every occurrence.",
    );
  }
  return parts.join(newText);
}

function propertyValue(
  change: Extract<NoteChange, { op: "set_property" }>,
  known: PropertyType | undefined,
  current: unknown,
): PropertyValue {
  const { value, type: valueType } = change;
  if (Array.isArray(value)) {
    if (valueType !== undefined && valueType !== "list") {
      throw new BackroomsError("invalid_argument", `A list cannot be a property of type ${valueType}.`);
    }
    return { type: "list", items: value.map(String) };
  }
  if (valueType === undefined && typeof value === "number") return { type: "number", value };
  if (valueType === undefined && typeof value === "boolean") return { type: "checkbox", value };
  return parsePropertyValue(String(value), valueType ?? inferValueType(known, current));
}
