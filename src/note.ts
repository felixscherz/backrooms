import { parse as parseYaml } from "yaml";

/** A half-open range of character offsets into a note's text. */
export type Span = { start: number; end: number };

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type Properties = { [key: string]: JsonValue };

export type Subpath = { kind: "heading"; headings: string[] } | { kind: "block"; id: string };

export type LinkLocation = { kind: "body"; span: Span } | { kind: "property"; key: string };

export type Link = {
  syntax: "wikilink" | "markdown";
  embed: boolean;
  /** The link path as written, without subpath and decoded for markdown links. Empty for links to the note itself. */
  target: string;
  subpath: Subpath | null;
  displayText: string | null;
  location: LinkLocation;
};

export type Heading = { level: number; text: string; line: number };

/**
 * The frontmatter block of a note. `span` covers the whole block including both `---` lines and the newline after
 * the closing one, `yamlSpan` only the YAML between them.
 */
export type Frontmatter =
  | { kind: "none" }
  | { kind: "valid"; span: Span; yamlSpan: Span }
  | { kind: "invalid"; span: Span; yamlSpan: Span; error: string };

export type Note = {
  frontmatter: Frontmatter;
  properties: Properties;
  /** Tags without the leading `#`, once per note in the case they first appear in. */
  tags: string[];
  aliases: string[];
  headings: Heading[];
  blockIds: string[];
  links: Link[];
};

export function parseNote(text: string): Note {
  const frontmatter = findFrontmatter(text);
  const properties = frontmatter.kind === "valid" ? parseProperties(text, frontmatter.yamlSpan) : {};
  const bodyStart = frontmatter.kind === "none" ? 0 : frontmatter.span.end;
  const masked = maskIgnoredText(text, bodyStart);

  return {
    frontmatter,
    properties,
    tags: uniqueIgnoringCase([...propertyTags(properties), ...inlineTags(masked)]),
    aliases: listProperty(properties, ["aliases", "alias"]),
    headings: findHeadings(masked),
    blockIds: findBlockIds(masked),
    links: [...propertyLinks(properties), ...bodyLinks(text, masked)],
  };
}

function findFrontmatter(text: string): Frontmatter {
  const opening = /^---[ \t]*\r?\n/.exec(text);
  if (!opening) return { kind: "none" };

  const closing = /^---[ \t]*(\r?\n|$)/gm;
  closing.lastIndex = opening[0].length;
  const match = closing.exec(text);
  if (!match) return { kind: "none" };

  const span = { start: 0, end: match.index + match[0].length };
  const yamlSpan = { start: opening[0].length, end: match.index };
  try {
    const value = parseYaml(text.slice(yamlSpan.start, yamlSpan.end));
    if (value !== null && value !== undefined && !isPlainObject(value)) {
      return { kind: "invalid", span, yamlSpan, error: "frontmatter is not a map of properties" };
    }
    return { kind: "valid", span, yamlSpan };
  } catch (error) {
    return { kind: "invalid", span, yamlSpan, error: error instanceof Error ? error.message : String(error) };
  }
}

function parseProperties(text: string, yamlSpan: Span): Properties {
  const value: unknown = parseYaml(text.slice(yamlSpan.start, yamlSpan.end));
  return isPlainObject(value) ? (toJson(value) as Properties) : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJson(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJson);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]));
  return String(value);
}

/**
 * Returns the text with everything Obsidian does not read as markdown structure replaced by spaces: the frontmatter,
 * fenced code blocks, inline code and `%%` comments. Newlines and offsets are kept, so matches in the masked text
 * point at the same place in the original.
 */
export function maskIgnoredText(text: string, bodyStart: number): string {
  const chars = text.split("");
  const blank = (start: number, end: number) => {
    for (let i = start; i < end; i++) if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
  };
  blank(0, bodyStart);

  let fence: { char: string; length: number } | null = null;
  let inComment = false;
  let offset = bodyStart;
  for (const line of text.slice(bodyStart).split("\n")) {
    const lineEnd = offset + line.length;
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
      if (close?.[1]?.startsWith(fence.char) && close[1].length >= fence.length) fence = null;
      blank(offset, lineEnd);
    } else if (!inComment && /^ {0,3}(`{3,}|~{3,})/.test(line)) {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)![1]!;
      fence = { char: marker[0]!, length: marker.length };
      blank(offset, lineEnd);
    } else {
      inComment = maskInline(text, offset, lineEnd, inComment, blank);
    }
    offset = lineEnd + 1;
  }
  return chars.join("");
}

/** Masks inline code and comments within one line. Returns whether a comment is still open at the end of the line. */
function maskInline(
  text: string,
  start: number,
  end: number,
  inComment: boolean,
  blank: (start: number, end: number) => void,
): boolean {
  let i = start;
  if (inComment) {
    const close = text.indexOf("%%", i);
    if (close === -1 || close >= end) {
      blank(start, end);
      return true;
    }
    blank(start, close + 2);
    i = close + 2;
  }
  while (i < end) {
    if (text.startsWith("%%", i)) {
      const close = text.indexOf("%%", i + 2);
      if (close === -1 || close >= end) {
        blank(i, end);
        return true;
      }
      blank(i, close + 2);
      i = close + 2;
    } else if (text[i] === "`") {
      let run = 0;
      while (text[i + run] === "`") run++;
      const ticks = "`".repeat(run);
      let close = text.indexOf(ticks, i + run);
      while (close !== -1 && close < end && text[close + run] === "`") close = text.indexOf(ticks, close + run + 1);
      if (close === -1 || close >= end) {
        i += run;
        continue;
      }
      blank(i, close + run);
      i = close + run;
    } else {
      i++;
    }
  }
  return false;
}

const TAG_BODY = /[^\s!"#$%&'()*+,.:;<=>?@[\\\]^`{|}~]+/u;
const INLINE_TAG = new RegExp(`(?<=^|\\s)#(${TAG_BODY.source})`, "gu");

export function isValidTag(tag: string): boolean {
  return new RegExp(`^${TAG_BODY.source}$`, "u").test(tag) && !/^[0-9/]+$/.test(tag);
}

function inlineTags(masked: string): string[] {
  return [...masked.matchAll(INLINE_TAG)].map((match) => match[1]!).filter(isValidTag);
}

function propertyTags(properties: Properties): string[] {
  return listProperty(properties, ["tags", "tag"], /[,\s]+/)
    .map((tag) => tag.replace(/^#/, ""))
    .filter(isValidTag);
}

/** Reads a property that Obsidian treats as a list, also when it is written as a separated string. */
function listProperty(properties: Properties, keys: string[], separator: RegExp = /,/): string[] {
  const result: string[] = [];
  for (const key of keys) {
    const value = properties[key];
    const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(separator) : [];
    for (const item of items) {
      if (typeof item === "string" || typeof item === "number") {
        const text = String(item).trim();
        if (text) result.push(text);
      }
    }
  }
  return result;
}

function uniqueIgnoringCase(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findHeadings(masked: string): Heading[] {
  const headings: Heading[] = [];
  masked.split("\n").forEach((line, index) => {
    const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*\r?$/.exec(line);
    if (!match) return;
    const text = (match[2] ?? "").replace(/(^|[ \t]+)#+$/, "").trim();
    headings.push({ level: match[1]!.length, text, line: index });
  });
  return headings;
}

function findBlockIds(masked: string): string[] {
  return masked
    .split("\n")
    .map((line) => /(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*\r?$/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
}

const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const MARKDOWN_LINK = /(!?)\[([^[\]\n]*)\]\(\s*(<[^<>\n]*>|[^\s()]*)(?:\s+"[^"\n]*")?\s*\)/g;

function bodyLinks(text: string, masked: string): Link[] {
  const links: Link[] = [];
  const taken: Span[] = [];
  for (const match of masked.matchAll(WIKILINK)) {
    const span = { start: match.index, end: match.index + match[0].length };
    taken.push(span);
    const inner = text.slice(span.start + match[1]!.length + 2, span.end - 2);
    links.push({
      ...parseWikilinkInner(inner),
      syntax: "wikilink",
      embed: match[1] === "!",
      location: { kind: "body", span },
    });
  }
  for (const match of masked.matchAll(MARKDOWN_LINK)) {
    const span = { start: match.index, end: match.index + match[0].length };
    if (taken.some((other) => span.start < other.end && other.start < span.end)) continue;
    const original = text.slice(span.start, span.end);
    const parts = new RegExp(MARKDOWN_LINK.source).exec(original)!;
    const link = parseMarkdownDestination(parts[3]!);
    if (!link) continue;
    links.push({
      ...link,
      syntax: "markdown",
      embed: parts[1] === "!",
      displayText: parts[2]!,
      location: { kind: "body", span },
    });
  }
  return links.sort((a, b) => spanStart(a) - spanStart(b));
}

function spanStart(link: Link): number {
  return link.location.kind === "body" ? link.location.span.start : -1;
}

/** Parses the text between `[[` and `]]`. */
export function parseWikilinkInner(inner: string): Pick<Link, "target" | "subpath" | "displayText"> {
  const pipe = inner.indexOf("|");
  const path = (pipe === -1 ? inner : inner.slice(0, pipe)).replace(/\\$/, "");
  const displayText = pipe === -1 ? null : inner.slice(pipe + 1);
  return { ...splitSubpath(path), displayText };
}

function parseMarkdownDestination(raw: string): Pick<Link, "target" | "subpath"> | null {
  const destination = raw.startsWith("<") ? raw.slice(1, -1) : raw;
  if (destination === "" || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(destination) || destination.startsWith("//")) return null;
  const { target, subpath } = splitSubpath(destination);
  return { target: decode(target), subpath: decodeSubpath(subpath) };
}

function splitSubpath(path: string): Pick<Link, "target" | "subpath"> {
  const hash = path.indexOf("#");
  if (hash === -1) return { target: path.trim(), subpath: null };
  const rest = path.slice(hash + 1);
  const subpath: Subpath = rest.startsWith("^")
    ? { kind: "block", id: rest.slice(1).trim() }
    : {
        kind: "heading",
        headings: rest
          .split("#")
          .map((part) => part.trim())
          .filter((part) => part !== ""),
      };
  return { target: path.slice(0, hash).trim(), subpath };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeSubpath(subpath: Subpath | null): Subpath | null {
  if (!subpath) return null;
  return subpath.kind === "block"
    ? { kind: "block", id: decode(subpath.id) }
    : { kind: "heading", headings: subpath.headings.map(decode) };
}

function propertyLinks(properties: Properties): Link[] {
  const links: Link[] = [];
  const visit = (key: string, value: JsonValue) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(WIKILINK)) {
        links.push({
          ...parseWikilinkInner(match[2]!),
          syntax: "wikilink",
          embed: match[1] === "!",
          location: { kind: "property", key },
        });
      }
    } else if (Array.isArray(value)) {
      value.forEach((item) => visit(key, item));
    }
  };
  for (const [key, value] of Object.entries(properties)) visit(key, value);
  return links;
}
