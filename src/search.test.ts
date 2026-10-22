import { describe, expect, test } from "bun:test";
import { parseNote } from "./note";
import { matchFile, parseQuery } from "./search";

const files = [
  {
    path: "Recipes/Pizza.md",
    text: "---\ncuisine: italian\nrating: 5\n---\n# Pizza\nDough with yeast.\n#resource/cooking\n",
  },
  { path: "Bread.md", text: "# Bread\nAlso uses yeast and flour.\n#resource/baking\n" },
  { path: "Journal.md", text: "Ate pizza today.\nNo yeast involved.\n" },
].map((file) => ({ ...file, note: parseNote(file.text) }));

function search(query: string, caseSensitive = false): string[] {
  const options = { caseSensitive };
  const parsed = parseQuery(query, options);
  return files.filter((file) => matchFile(parsed, file, options)).map((file) => file.path);
}

describe("search syntax", () => {
  test("all words have to occur somewhere in the note", () => {
    expect(search("yeast flour")).toEqual(["Bread.md"]);
  });

  test("a word also matches the file path", () => {
    expect(search("recipes")).toEqual(["Recipes/Pizza.md"]);
  });

  test("OR matches either side", () => {
    expect(search("flour OR dough")).toEqual(["Recipes/Pizza.md", "Bread.md"]);
  });

  test("a leading minus excludes notes", () => {
    expect(search("yeast -pizza")).toEqual(["Bread.md"]);
  });

  test("quotes match a phrase", () => {
    expect(search('"pizza today"')).toEqual(["Journal.md"]);
  });

  test("parentheses group terms", () => {
    expect(search("yeast (flour OR dough)")).toEqual(["Recipes/Pizza.md", "Bread.md"]);
  });

  test("a regular expression between slashes", () => {
    expect(search("/Dough w.th/")).toEqual(["Recipes/Pizza.md"]);
  });

  test("case matters only when asked for", () => {
    expect(search("PIZZA")).toHaveLength(2);
    expect(search("PIZZA", true)).toEqual([]);
  });

  test("file: and path: match only the name or the path", () => {
    expect(search("file:pizza")).toEqual(["Recipes/Pizza.md"]);
    expect(search("path:recipes/")).toEqual(["Recipes/Pizza.md"]);
  });

  test("content: ignores the file name", () => {
    expect(search("content:recipes")).toEqual([]);
  });

  test("line: needs all terms on the same line", () => {
    expect(search("line:(yeast flour)")).toEqual(["Bread.md"]);
    expect(search("line:(pizza yeast)")).toEqual([]);
  });

  test("tag: matches a tag and the tags nested below it", () => {
    expect(search("tag:#resource")).toEqual(["Recipes/Pizza.md", "Bread.md"]);
    expect(search("tag:resource/baking")).toEqual(["Bread.md"]);
  });

  test("[property] and [property:value] match frontmatter", () => {
    expect(search("[cuisine]")).toEqual(["Recipes/Pizza.md"]);
    expect(search("[rating:5]")).toEqual(["Recipes/Pizza.md"]);
    expect(search("[cuisine:french]")).toEqual([]);
  });

  test("an unknown operator is an error in the Obsidian CLI's wording", () => {
    expect(() => search("cuisine:italian")).toThrow('Operator "cuisine" not recognized');
  });
});

describe("operators for parts of a note", () => {
  const note = {
    path: "Note.md",
    text: [
      "---",
      "mood: happy",
      "---",
      "# Plan",
      "Buy flour",
      "- [ ] bake bread",
      "- [x] buy yeast",
      "",
      "## Later",
      "Eat bread with butter",
      "and jam",
      "```",
      "flour in code",
      "```",
    ].join("\n"),
  };
  const matches = (query: string) => {
    const options = { caseSensitive: false };
    return matchFile(parseQuery(query, options), { ...note, note: parseNote(note.text) }, options) !== null;
  };

  test("block: matches within one paragraph, list, heading, code block or the frontmatter", () => {
    expect(matches("block:(butter jam)")).toBe(true);
    expect(matches("block:(bake yeast)")).toBe(true);
    expect(matches("block:(flour bake)")).toBe(false);
    expect(matches("block:(plan flour)")).toBe(false);
    expect(matches("block:(mood happy)")).toBe(true);
    expect(matches("block:(code jam)")).toBe(false);
  });

  test("section: matches between one heading and the next", () => {
    expect(matches("section:(plan yeast)")).toBe(true);
    expect(matches("section:(plan butter)")).toBe(false);
    expect(matches("section:(later code)")).toBe(true);
  });

  test("task:, task-todo: and task-done: match within one task", () => {
    expect(matches("task:(bake bread)")).toBe(true);
    expect(matches("task:(bake yeast)")).toBe(false);
    expect(matches("task-todo:bake")).toBe(true);
    expect(matches("task-todo:yeast")).toBe(false);
    expect(matches("task-done:yeast")).toBe(true);
  });

  test("match-case: and ignore-case: set the case sensitivity of their part", () => {
    expect(matches("match-case:Plan")).toBe(true);
    expect(matches("match-case:plan")).toBe(false);
    expect(matches("match-case:/Pl.n/")).toBe(true);
    expect(matches("match-case:/pl.n/")).toBe(false);
    const options = { caseSensitive: true };
    expect(
      matchFile(parseQuery("ignore-case:/PLAN/", options), { ...note, note: parseNote(note.text) }, options),
    ).not.toBe(null);
  });
});

describe("search context", () => {
  test("the lines that match a term are returned with their line number", () => {
    const options = { caseSensitive: false };
    const match = matchFile(parseQuery("yeast", options), files[2]!, options);

    expect(match?.lines).toEqual([{ line: 2, text: "No yeast involved." }]);
  });
});
