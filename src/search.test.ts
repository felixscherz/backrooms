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

  test("operators backroom does not implement are reported, not ignored", () => {
    expect(() => parseQuery("section:(pizza)", { caseSensitive: false })).toThrow('"section:" is not supported');
  });
});

describe("search context", () => {
  test("the lines that match a term are returned with their line number", () => {
    const options = { caseSensitive: false };
    const match = matchFile(parseQuery("yeast", options), files[2]!, options);

    expect(match?.lines).toEqual([{ line: 2, text: "No yeast involved." }]);
  });
});
