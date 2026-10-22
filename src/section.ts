import { BackroomsError } from "./errors";
import type { Heading, Span } from "./note";

/** The text under a heading, up to the next heading of the same or a higher level, with the heading line itself. */
export type Section = {
  /** The heading and the headings it sits below, such as `June > 2026-06-23`. */
  heading: string;
  /** The line of the heading, numbered from 1. */
  line: number;
  text: string;
  /** Where the section sits in the note's text. */
  span: Span;
  /** Where its first subsection starts, or its end when it has none, so the text before is the heading's own. */
  ownEnd: number;
};

/**
 * Finds a section by its heading's text, or by a path of headings separated by `>`, such as `June > 2026-06-23`,
 * where each earlier heading has to be one the section sits below. Headings match ignoring case and leading `#`.
 * A heading that matches several sections is an error that lists each one, so the caller can name the right one.
 */
export function findSection(text: string, headings: Heading[], wanted: string, path: string): Section {
  const segments = wanted
    .split(">")
    .map(headingKey)
    .filter((segment) => segment !== "");
  if (segments.length === 0) throw new BackroomsError("invalid_argument", "The section's heading must not be empty.");

  const placed = withAncestors(headings);
  const matches = placed.filter(({ heading, ancestors }) => {
    if (headingKey(heading.text) !== segments.at(-1)) return false;
    let next = 0;
    for (const ancestor of ancestors) if (headingKey(ancestor.text) === segments[next]) next++;
    return next >= segments.length - 1;
  });
  if (matches.length === 0) {
    const available = placed.map(({ heading, ancestors }) => describe(heading, ancestors));
    throw new BackroomsError(
      "not_found",
      `No heading "${wanted}" in "${path}".` +
        (available.length === 0 ? " The note has no headings." : ` Its headings: ${available.join("; ")}.`),
    );
  }
  if (matches.length > 1) {
    const listed = matches.map(({ heading, ancestors }) => describe(heading, ancestors));
    throw new BackroomsError(
      "invalid_argument",
      `"${wanted}" matches ${matches.length} headings in "${path}": ${listed.join("; ")}. Name one by its path.`,
    );
  }

  const { heading, ancestors } = matches[0]!;
  const next = headings.find((other) => other.line > heading.line && other.level <= heading.level);
  const start = lineOffset(text, heading.line);
  const end = next ? lineOffset(text, next.line) : text.length;
  const subsection = headings.find((other) => other.line > heading.line);
  const ownEnd = subsection && subsection.level > heading.level ? lineOffset(text, subsection.line) : end;
  return {
    heading: headingPath(heading, ancestors),
    line: heading.line + 1,
    text: text.slice(start, end),
    span: { start, end },
    ownEnd,
  };
}

type Placed = { heading: Heading; ancestors: Heading[] };

/** Each heading with the headings it sits below, the way an outline nests them. */
function withAncestors(headings: Heading[]): Placed[] {
  const open: Heading[] = [];
  return headings.map((heading) => {
    while (open.length > 0 && open.at(-1)!.level >= heading.level) open.pop();
    const placed = { heading, ancestors: [...open] };
    open.push(heading);
    return placed;
  });
}

function headingPath(heading: Heading, ancestors: Heading[]): string {
  return [...ancestors, heading].map((each) => each.text).join(" > ");
}

function describe(heading: Heading, ancestors: Heading[]): string {
  return `${headingPath(heading, ancestors)} (line ${heading.line + 1})`;
}

function headingKey(text: string): string {
  return text
    .replace(/^\s*#+\s*/, "")
    .trim()
    .toLowerCase();
}

/** Where a line starts, counting lines from 0. */
function lineOffset(text: string, line: number): number {
  let offset = 0;
  for (let current = 0; current < line; current++) offset = text.indexOf("\n", offset) + 1;
  return offset;
}
