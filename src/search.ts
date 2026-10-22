import { BackroomError } from "./errors";
import type { JsonValue, Note } from "./note";
import { basename } from "./paths";

/**
 * A parsed search query in Obsidian's search syntax. Words are combined with AND, `OR` and parentheses group,
 * `-` negates, `"..."` matches a phrase and `/.../` a regular expression. The operators `file:`, `path:`,
 * `content:`, `tag:` and `[property]` / `[property:value]` narrow what a term is matched against, `line:`,
 * `block:`, `section:`, `task:`, `task-todo:` and `task-done:` require their terms to match within one part of
 * the note, and `match-case:` and `ignore-case:` set the case sensitivity of their terms. In a property's value,
 * `>` and `<` compare the value with the text after them.
 */
export type Query =
  | { kind: "text"; text: string }
  | { kind: "regex"; pattern: RegExp }
  | { kind: "compare"; operator: ">" | "<"; text: string }
  | { kind: "and"; parts: Query[] }
  | { kind: "or"; parts: Query[] }
  | { kind: "not"; part: Query }
  | { kind: "field"; field: TextField; part: Query }
  | { kind: "within"; unit: Unit; part: Query }
  | { kind: "case"; caseSensitive: boolean; part: Query }
  | { kind: "tag"; tag: string }
  | { kind: "property"; name: string; value: Query | null };

type TextField = "file" | "path" | "content";

/** A part of a note that the terms of an operator have to match within. */
type Unit = "line" | "block" | "section" | "task" | "task-todo" | "task-done";

const UNITS: readonly string[] = ["line", "block", "section", "task", "task-todo", "task-done"];
const FIELDS: readonly string[] = ["file", "path", "content"];

export type SearchOptions = { caseSensitive: boolean };

export type SearchableFile = { path: string; text: string; note: Note };

export type FileMatch = {
  path: string;
  /** Lines of the content that match the query, numbered from 1. */
  lines: { line: number; text: string }[];
};

export function parseQuery(input: string, options: SearchOptions): Query {
  const parser = new Parser(input, options);
  const query = parser.parseAll();
  if (!query) throw new BackroomError("invalid_argument", "Search query is empty.");
  return query;
}

/** Matches one file against a query. Returns null when the file does not match. */
export function matchFile(query: Query, file: SearchableFile, options: SearchOptions): FileMatch | null {
  const scope: Scope = { texts: [file.text, file.path], file };
  if (!evaluate(query, scope, options)) return null;
  const lines = file.text
    .split("\n")
    .map((text, index) => ({ line: index + 1, text: text.replace(/\r$/, "") }))
    .filter(({ text }) => positiveTerms(query).some((term) => termMatches(term, text, options)));
  return { path: file.path, lines };
}

type Scope = { texts: string[]; file: SearchableFile };

function evaluate(query: Query, scope: Scope, options: SearchOptions): boolean {
  switch (query.kind) {
    case "text":
    case "regex":
      return scope.texts.some((text) => termMatches(query, text, options));
    case "and":
      return query.parts.every((part) => evaluate(part, scope, options));
    case "or":
      return query.parts.some((part) => evaluate(part, scope, options));
    case "not":
      return !evaluate(query.part, scope, options);
    case "field":
      return evaluate(query.part, { ...scope, texts: [fieldText(query.field, scope.file)] }, options);
    case "within":
      return unitsOf(query.unit, scope.file).some((unit) => evaluate(query.part, { ...scope, texts: [unit] }, options));
    case "case":
      return evaluate(query.part, scope, { caseSensitive: query.caseSensitive });
    case "tag": {
      const wanted = query.tag.toLowerCase();
      return scope.file.note.tags.some((tag) => {
        const lower = tag.toLowerCase();
        return lower === wanted || lower.startsWith(`${wanted}/`);
      });
    }
    case "compare":
      return false;
    case "property": {
      const wanted = query.name.toLowerCase();
      const properties = Object.entries(scope.file.note.properties).filter(([name]) =>
        name.toLowerCase().includes(wanted),
      );
      if (!query.value) return properties.length > 0;
      const values = properties.flatMap(([, value]) => valuesOf(value));
      return values.some((value) => matchesValue(query.value!, value, options));
    }
  }
}

/** The values of a property one by one: each item of a list, or the value itself. */
function valuesOf(value: JsonValue): JsonValue[] {
  return Array.isArray(value) ? value.flatMap(valuesOf) : [value];
}

/**
 * Whether one property value matches the query in a property's brackets. Unlike in the rest of a query, a
 * negation only narrows what the other terms match, so `[label:-apple]` alone matches nothing, as in Obsidian.
 */
function matchesValue(query: Query, value: JsonValue, options: SearchOptions): boolean {
  switch (query.kind) {
    case "text":
    case "regex":
      return value !== null && termMatches(query, valueText(value), options);
    case "compare":
      return compares(query, value);
    case "and": {
      const positive = query.parts.filter((part) => part.kind !== "not");
      const negated = query.parts.flatMap((part) => (part.kind === "not" ? [part.part] : []));
      return (
        positive.length > 0 &&
        positive.every((part) => matchesValue(part, value, options)) &&
        !negated.some((part) => matchesValue(part, value, options))
      );
    }
    case "or":
      return query.parts.some((part) => matchesValue(part, value, options));
    case "case":
      return matchesValue(query.part, value, { caseSensitive: query.caseSensitive });
    default:
      return false;
  }
}

function valueText(value: JsonValue): string {
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

/**
 * Compares a value with JavaScript's `>` and `<`, as Obsidian does: numbers by value when the text is a number,
 * everything else as text by code units. So `2026-10-21 09:15:00` is after `2026-10-21`, and `10` after `9` only
 * when the property holds a number. A comparison without text matches every value, missing ones included.
 */
function compares(query: Query & { kind: "compare" }, value: JsonValue): boolean {
  if (query.text === "") return true;
  if (value === null) return false;
  const left = (typeof value === "object" ? String(value) : value) as string;
  return query.operator === ">" ? left > query.text : left < query.text;
}

function fieldText(field: TextField, file: SearchableFile): string {
  switch (field) {
    case "file":
      return basename(file.path);
    case "path":
      return file.path;
    case "content":
      return file.text;
  }
}

function termMatches(term: Query & { kind: "text" | "regex" }, text: string, options: SearchOptions): boolean {
  if (term.kind === "regex") return term.pattern.test(text);
  return options.caseSensitive ? text.includes(term.text) : text.toLowerCase().includes(term.text.toLowerCase());
}

/** The terms that match content, used to pick the lines shown as context. */
function positiveTerms(query: Query): (Query & { kind: "text" | "regex" })[] {
  switch (query.kind) {
    case "text":
    case "regex":
      return [query];
    case "and":
    case "or":
      return query.parts.flatMap(positiveTerms);
    case "within":
    case "case":
      return positiveTerms(query.part);
    case "field":
      return query.field === "content" ? positiveTerms(query.part) : [];
    default:
      return [];
  }
}

/** The parts of a note that the terms of a `line:`, `block:`, `section:` or `task:` operator match within. */
function unitsOf(unit: Unit, file: SearchableFile): string[] {
  const lines = file.text.split("\n").map((line) => line.replace(/\r$/, ""));
  switch (unit) {
    case "line":
      return lines;
    case "block":
      return blocks(lines, file.note);
    case "section": {
      const starts = [0, ...file.note.headings.map((heading) => heading.line).filter((line) => line > 0)];
      return starts.map((start, index) => lines.slice(start, starts[index + 1]).join("\n"));
    }
    case "task":
    case "task-todo":
    case "task-done":
      return tasks(lines, file.note).flatMap((task) =>
        unit === "task" || (unit === "task-todo") === (task.status === " ") ? [task.text] : [],
      );
  }
}

type BodyLine = { index: number; text: string; code: "fence" | "inside" | null };

/** The lines after the frontmatter, each marked when it opens or closes a code block, or lies inside one. */
function bodyLines(lines: string[], note: Note): BodyLine[] {
  const start =
    note.frontmatter.kind === "none" ? 0 : lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line)) + 1;
  let fence: string | null = null;
  return lines.slice(start).map((text, offset): BodyLine => {
    const index = start + offset;
    if (fence !== null) {
      if (!text.trimStart().startsWith(fence) || text.trim().replace(/[`~]/g, "") !== "") {
        return { index, text, code: "inside" };
      }
      fence = null;
      return { index, text, code: "fence" };
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    if (!opening) return { index, text, code: null };
    fence = opening[1]!;
    return { index, text, code: "fence" };
  });
}

/**
 * Splits a note into its markdown blocks, as Obsidian's `block:` sees them: the frontmatter, each heading, each
 * code block, and paragraphs and lists, which blank lines separate and a list item also starts.
 */
function blocks(lines: string[], note: Note): string[] {
  const body = bodyLines(lines, note);
  const result = body[0] && body[0].index > 0 ? [lines.slice(0, body[0].index).join("\n")] : [];
  const headings = new Set(note.headings.map((heading) => heading.line));
  let current: string[] = [];
  let kind: "paragraph" | "list" | "code" | null = null;
  const flush = () => {
    if (current.length > 0) result.push(current.join("\n"));
    current = [];
    kind = null;
  };
  for (const line of body) {
    if (line.code !== null) {
      if (kind !== "code") flush();
      kind = "code";
      current.push(line.text);
      if (line.code === "fence" && current.length > 1) flush();
    } else if (line.text.trim() === "") {
      flush();
    } else if (headings.has(line.index)) {
      flush();
      result.push(line.text);
    } else {
      const listItem = /^\s*(?:[-*+]|\d+[.)])\s/.test(line.text);
      if ((listItem && kind !== "list") || kind === "code") flush();
      kind ??= listItem ? "list" : "paragraph";
      current.push(line.text);
    }
  }
  flush();
  return result;
}

/** The tasks of a note outside code blocks, with the character in their checkbox and the text after it. */
function tasks(lines: string[], note: Note): { status: string; text: string }[] {
  return bodyLines(lines, note).flatMap((line) => {
    const task = line.code === null ? /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\](?:\s+(.*))?$/.exec(line.text) : null;
    return task ? [{ status: task[1]!, text: task[2] ?? "" }] : [];
  });
}

/** The text up to the first colon outside quotes, which ends the value of a property in Obsidian. */
function untilColon(text: string): string {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') quoted = !quoted;
    else if (text[i] === ":" && !quoted) return text.slice(0, i);
  }
  return text;
}

class Parser {
  private position = 0;

  constructor(
    private readonly input: string,
    private options: SearchOptions,
    /** Whether this parses the value in a property's brackets, where `>` and `<` compare. */
    private readonly inProperty = false,
  ) {}

  parseAll(): Query | null {
    const query = this.parseOr();
    this.skipSpace();
    if (this.position < this.input.length) this.fail(`Unexpected "${this.input[this.position]}"`);
    return query;
  }

  private parseOr(): Query | null {
    const parts: Query[] = [];
    let part = this.parseAnd();
    if (part) parts.push(part);
    while (this.consumeKeyword("OR")) {
      part = this.parseAnd();
      if (!part) this.fail("Expected a term after OR");
      parts.push(part);
    }
    if (parts.length <= 1) return parts[0] ?? null;
    return { kind: "or", parts };
  }

  private parseAnd(): Query | null {
    const parts: Query[] = [];
    for (;;) {
      this.skipSpace();
      if (this.atEnd() || this.peek() === ")" || this.peekKeyword("OR")) break;
      parts.push(this.parseUnary());
    }
    if (parts.length <= 1) return parts[0] ?? null;
    return { kind: "and", parts };
  }

  private parseUnary(): Query {
    if (this.peek() === "-" && this.position + 1 < this.input.length && !/\s/.test(this.input[this.position + 1]!)) {
      this.position++;
      return { kind: "not", part: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Query {
    const char = this.peek();
    if (char === "(") return this.parseGroup();
    if (char === '"') return { kind: "text", text: this.parseQuoted() };
    if (char === "/") {
      const regex = this.tryParseRegex();
      if (regex) return regex;
    }
    if (char === "[") return this.parseProperty();
    if (this.inProperty && (char === ">" || char === "<")) return this.parseComparison(char);

    const operator = /^([a-z-]+):/.exec(this.input.slice(this.position));
    if (operator) {
      this.position += operator[0].length;
      return this.parseOperator(operator[1]!);
    }
    return { kind: "text", text: this.parseWord() };
  }

  private parseOperator(name: string): Query {
    if (name === "tag") {
      const tag = this.peek() === '"' ? this.parseQuoted() : this.parseWord();
      return { kind: "tag", tag: tag.replace(/^#/, "") };
    }
    if (name === "match-case" || name === "ignore-case") {
      const outer = this.options;
      this.options = { caseSensitive: name === "match-case" };
      try {
        return { kind: "case", caseSensitive: this.options.caseSensitive, part: this.parseOperand() };
      } finally {
        this.options = outer;
      }
    }
    if (UNITS.includes(name)) return { kind: "within", unit: name as Unit, part: this.parseOperand() };
    if (FIELDS.includes(name)) return { kind: "field", field: name as TextField, part: this.parseOperand() };
    throw new BackroomError("invalid_argument", `Operator "${name}" not recognized`);
  }

  /** The value after an operator: a group, a phrase, a regex or a word. */
  private parseOperand(): Query {
    const char = this.peek();
    if (char === "(") return this.parseGroup();
    if (char === '"') return { kind: "text", text: this.parseQuoted() };
    if (char === "/") {
      const regex = this.tryParseRegex();
      if (regex) return regex;
    }
    if (this.atEnd() || /\s/.test(char)) this.fail("Expected a value after the operator");
    return { kind: "text", text: this.parseWord() };
  }

  private parseGroup(): Query {
    this.position++;
    const query = this.parseOr();
    this.skipSpace();
    if (this.peek() !== ")") this.fail('Expected ")"');
    this.position++;
    if (!query) this.fail("Empty group");
    return query;
  }

  private parseProperty(): Query {
    const close = this.input.indexOf("]", this.position);
    if (close === -1) this.fail('Expected "]"');
    const inner = this.input.slice(this.position + 1, close);
    this.position = close + 1;
    const colon = inner.indexOf(":");
    if (colon === -1) return { kind: "property", name: inner.trim(), value: null };
    const valueText = untilColon(inner.slice(colon + 1)).trim();
    if (valueText.includes("[")) {
      throw new BackroomError("invalid_argument", "Property cannot be nested within a property.");
    }
    const value = valueText === "" ? null : new Parser(valueText, this.options, true).parseAll();
    return { kind: "property", name: inner.slice(0, colon).trim(), value };
  }

  /** `>` or `<` and the text after it. Without text, the comparison matches every value. */
  private parseComparison(operator: ">" | "<"): Query {
    this.position++;
    const char = this.peek();
    if (char === "-" || char === "/" || char === "(") {
      const name = operator === ">" ? "greaterthan" : "lessthan";
      const operand = char === "-" ? "a negation" : char === "/" ? "a regular expression" : "a group";
      throw new BackroomError("invalid_argument", `Invalid search query: ${name} cannot be applied to ${operand}.`);
    }
    if (char === '"') return { kind: "compare", operator, text: this.parseQuoted() };
    return { kind: "compare", operator, text: this.parseWord() };
  }

  private parseQuoted(): string {
    let text = "";
    this.position++;
    while (!this.atEnd() && this.peek() !== '"') {
      if (this.peek() === "\\" && this.position + 1 < this.input.length) this.position++;
      text += this.input[this.position++];
    }
    if (this.atEnd()) this.fail("Unterminated quote");
    this.position++;
    return text;
  }

  private tryParseRegex(): Query | null {
    let end = this.position + 1;
    while (end < this.input.length && this.input[end] !== "/") {
      if (this.input[end] === "\\") end++;
      end++;
    }
    if (end >= this.input.length || end === this.position + 1) return null;
    const source = this.input.slice(this.position + 1, end);
    try {
      const pattern = new RegExp(source, this.options.caseSensitive ? "" : "i");
      this.position = end + 1;
      return { kind: "regex", pattern };
    } catch (error) {
      throw new BackroomError("invalid_argument", `Invalid regular expression /${source}/.`);
    }
  }

  private parseWord(): string {
    const start = this.position;
    while (!this.atEnd() && !/[\s()]/.test(this.peek())) this.position++;
    return this.input.slice(start, this.position);
  }

  private consumeKeyword(keyword: string): boolean {
    this.skipSpace();
    if (!this.peekKeyword(keyword)) return false;
    this.position += keyword.length;
    return true;
  }

  private peekKeyword(keyword: string): boolean {
    const rest = this.input.slice(this.position);
    return rest.startsWith(keyword) && (rest.length === keyword.length || /[\s(]/.test(rest[keyword.length]!));
  }

  private skipSpace() {
    while (!this.atEnd() && /\s/.test(this.peek())) this.position++;
  }

  private peek(): string {
    return this.input[this.position] ?? "";
  }

  private atEnd(): boolean {
    return this.position >= this.input.length;
  }

  private fail(message: string): never {
    throw new BackroomError("invalid_argument", `Invalid search query: ${message}.`);
  }
}
