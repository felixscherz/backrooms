import { describe, expect, test } from "bun:test";
import { Vault } from "./vault";

const vault = Vault.fromFiles([
  { path: "Alpha.md" },
  { path: "Gamma.md" },
  { path: "folder/Gamma.md" },
  { path: "folder/Only Here.md" },
  { path: "folder/sub/Delta.md" },
  { path: "other/Delta.md" },
  { path: "assets/diagram.png" },
]);

describe("link resolution", () => {
  test("a link resolves to the note with that name, ignoring case and the .md extension", () => {
    expect(vault.resolve("alpha", "Gamma.md")).toBe("Alpha.md");
    expect(vault.resolve("Alpha.md", "Gamma.md")).toBe("Alpha.md");
  });

  test("a link to a note in a folder resolves by name alone", () => {
    expect(vault.resolve("Only Here", "Alpha.md")).toBe("folder/Only Here.md");
  });

  test("a link with a folder path resolves to that file", () => {
    expect(vault.resolve("folder/Gamma", "Alpha.md")).toBe("folder/Gamma.md");
  });

  test("a path is also tried relative to the folder of the linking note", () => {
    expect(vault.resolve("sub/Delta.md", "folder/Gamma.md")).toBe("folder/sub/Delta.md");
  });

  test("a link starting with ./ or ../ resolves only relative to the linking note", () => {
    expect(vault.resolve("../other/Delta.md", "folder/Gamma.md")).toBe("other/Delta.md");
    expect(vault.resolve("./Alpha", "folder/Gamma.md")).toBeNull();
  });

  test("of several notes with the same name, the one in the linking note's folder wins", () => {
    expect(vault.resolve("Delta", "folder/sub/Other.md")).toBe("folder/sub/Delta.md");
    expect(vault.resolve("Delta", "other/Other.md")).toBe("other/Delta.md");
  });

  test("of several notes with the same name elsewhere, the shortest path wins", () => {
    expect(vault.resolve("Delta", "Alpha.md")).toBe("other/Delta.md");
  });

  test("a link to an attachment needs its extension", () => {
    expect(vault.resolve("diagram.png", "Alpha.md")).toBe("assets/diagram.png");
    expect(vault.resolve("diagram", "Alpha.md")).toBeNull();
  });

  test("an empty link path points to the linking note itself", () => {
    expect(vault.resolve("", "Alpha.md")).toBe("Alpha.md");
  });

  test("a link to a missing note is unresolved", () => {
    expect(vault.resolve("Nowhere", "Alpha.md")).toBeNull();
  });
});

describe("backlinks", () => {
  test("links from the body and from properties both count as backlinks", () => {
    const linked = Vault.fromFiles([
      { path: "Target.md", text: "" },
      { path: "A.md", text: "[[Target]] and [[target|again]]" },
      { path: "B.md", text: '---\nup: "[[Target]]"\n---\n' },
      { path: "C.md", text: "[[Elsewhere]]" },
    ]);

    const backlinks = linked.backlinks("Target.md");

    expect([...backlinks.keys()]).toEqual(["A.md", "B.md"]);
    expect(backlinks.get("A.md")).toHaveLength(2);
  });
});

describe("excluded files", () => {
  test("excluded files are matched by path prefix or by regular expression", () => {
    const excluding = Vault.fromFiles([], { userIgnoreFilters: ["templates/", "/\\.excalidraw\\.md$/"] });

    expect(excluding.isExcluded("templates/Daily.md")).toBe(true);
    expect(excluding.isExcluded("Drawing.excalidraw.md")).toBe(true);
    expect(excluding.isExcluded("Note.md")).toBe(false);
  });
});
