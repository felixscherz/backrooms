import { describe, expect, test } from "bun:test";
import { parseNote } from "./note";

describe("properties", () => {
  test("frontmatter at the start of a note becomes its properties", () => {
    const note = parseNote("---\ntitle: Hello\nrating: 4\ndone: true\n---\nBody");

    expect(note.properties).toEqual({ title: "Hello", rating: 4, done: true });
  });

  test("a note without frontmatter has no properties", () => {
    expect(parseNote("Just text").properties).toEqual({});
  });

  test("invalid frontmatter yields no properties instead of failing", () => {
    expect(parseNote("---\n: [\n---\nBody").properties).toEqual({});
  });

  test("a horizontal rule later in the note is not frontmatter", () => {
    expect(parseNote("Intro\n---\nkey: value\n---").properties).toEqual({});
  });
});

describe("tags", () => {
  test("inline tags are collected, including nested tags", () => {
    const note = parseNote("Working on #project/alpha and #idea today.");

    expect(note.tags).toEqual(["project/alpha", "idea"]);
  });

  test("tags from the tags property are collected without a leading hash", () => {
    const note = parseNote("---\ntags: [daily, '#journal']\n---\n");

    expect(note.tags).toEqual(["daily", "journal"]);
  });

  test("a comma separated tags property is split into tags", () => {
    expect(parseNote("---\ntags: daily, journal\n---\n").tags).toEqual(["daily", "journal"]);
  });

  test("the same tag in different case is collected once", () => {
    expect(parseNote("#Idea and #idea").tags).toEqual(["Idea"]);
  });

  test("headings, purely numeric tags and url fragments are not tags", () => {
    const note = parseNote("# Heading\nIssue #123 at https://example.com/page#section");

    expect(note.tags).toEqual([]);
  });

  test("tags inside code and comments are ignored", () => {
    const note = parseNote("`#inline`\n```\n#fenced\n```\n%% #comment %%\n#real");

    expect(note.tags).toEqual(["real"]);
  });
});

describe("headings", () => {
  test("headings are collected with their level and text", () => {
    const note = parseNote("# Title\ntext\n## Section ##\n####### not a heading");

    expect(note.headings).toEqual([
      { level: 1, text: "Title", line: 0 },
      { level: 2, text: "Section", line: 2 },
    ]);
  });

  test("inline code in a heading is part of its text", () => {
    expect(parseNote("## Using `uv` here").headings).toEqual([{ level: 2, text: "Using `uv` here", line: 0 }]);
  });

  test("lines in a fenced code block are not headings", () => {
    expect(parseNote("~~~\n# comment\n~~~").headings).toEqual([]);
  });

  test("heading lines are counted from the start of the file, including frontmatter", () => {
    expect(parseNote("---\na: 1\n---\n# Title").headings).toEqual([{ level: 1, text: "Title", line: 3 }]);
  });
});

describe("block ids", () => {
  test("a caret id at the end of a line marks a block", () => {
    expect(parseNote("A paragraph ^para-1\nOther ^x").blockIds).toEqual(["para-1", "x"]);
  });
});

describe("links", () => {
  test("a wikilink points to its target", () => {
    const [link] = parseNote("See [[Other Note]].").links;

    expect(link).toEqual({
      syntax: "wikilink",
      embed: false,
      target: "Other Note",
      subpath: null,
      displayText: null,
      location: { kind: "body", span: { start: 4, end: 18 } },
    });
  });

  test("a wikilink can carry a heading subpath and display text", () => {
    const [link] = parseNote("[[folder/Note#Part#Sub|shown]]").links;

    expect(link?.target).toBe("folder/Note");
    expect(link?.subpath).toEqual({ kind: "heading", headings: ["Part", "Sub"] });
    expect(link?.displayText).toBe("shown");
  });

  test("a wikilink can point to a block", () => {
    expect(parseNote("[[Note#^abc]]").links[0]?.subpath).toEqual({ kind: "block", id: "abc" });
  });

  test("a wikilink with only a subpath points to the same note", () => {
    const [link] = parseNote("[[#Heading]]").links;

    expect(link?.target).toBe("");
    expect(link?.subpath).toEqual({ kind: "heading", headings: ["Heading"] });
  });

  test("an escaped pipe in a table separates the display text", () => {
    const [link] = parseNote("| [[Note\\|alias]] |").links;

    expect(link?.target).toBe("Note");
    expect(link?.displayText).toBe("alias");
  });

  test("an embed is a link marked as embedded", () => {
    const [link] = parseNote("![[diagram.png]]").links;

    expect(link?.embed).toBe(true);
    expect(link?.target).toBe("diagram.png");
    expect(link?.location).toEqual({ kind: "body", span: { start: 0, end: 16 } });
  });

  test("a markdown link to a vault file is a link with its path decoded", () => {
    const [link] = parseNote("[text](My%20Note.md#Some%20Part)").links;

    expect(link).toEqual({
      syntax: "markdown",
      embed: false,
      target: "My Note.md",
      subpath: { kind: "heading", headings: ["Some Part"] },
      displayText: "text",
      location: { kind: "body", span: { start: 0, end: 32 } },
    });
  });

  test("a markdown link target in angle brackets may contain spaces", () => {
    expect(parseNote("[t](<My Note.md>)").links[0]?.target).toBe("My Note.md");
  });

  test("markdown links to external urls are not vault links", () => {
    expect(parseNote("[site](https://example.com) [mail](mailto:a@b.c)").links).toEqual([]);
  });

  test("links inside code and comments are ignored", () => {
    const note = parseNote("`[[inline]]`\n```\n[[fenced]]\n```\n%%\n[[comment]]\n%%\n[[real]]");

    expect(note.links.map((link) => link.target)).toEqual(["real"]);
  });

  test("wikilinks in property values are links located at their property", () => {
    const note = parseNote('---\nrelated: ["[[A]]", "[[B|b]]"]\nup: "[[C]]"\n---\n');

    expect(note.links.map((link) => [link.target, link.location])).toEqual([
      ["A", { kind: "property", key: "related" }],
      ["B", { kind: "property", key: "related" }],
      ["C", { kind: "property", key: "up" }],
    ]);
  });
});
