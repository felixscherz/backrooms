import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tempVault, type TempVault } from "./testing/temp-vault";

let vault: TempVault;

beforeAll(async () => {
  vault = await tempVault({
    "Alpha.md": [
      "---",
      "date_created: 2026-10-20 14:05:00",
      "tags:",
      "  - inbox",
      "  - project/alpha",
      'aliases: [First, "The Alpha"]',
      "rating: 4",
      'related: ["[[Beta]]", "[[Missing Prop]]"]',
      "---",
      "# Alpha",
      "",
      "Intro with #idea, a [[Beta]] link and [[Beta|shown]] again.",
      "See [[Gamma#Section]], [[Nowhere]] and [[Nowhere]].",
      "Embed ![[diagram.png]] and [md](folder/Delta.md) and [site](https://example.com).",
      "",
      "## Second heading",
      "Pizza recipe mention.",
      "### Third ###",
    ].join("\n"),
    "Beta.md":
      "# Beta\n\nBack to [[Alpha]]. Also [[First]], which is an alias, not a note. Pizza is great.\n#idea #real-tag\n",
    "Gamma.md": "---\ntags: resource/cooking\n---\n# Gamma\n\n## Section\nPizza dough. [[Alpha#Second heading]]\n",
    "folder/Delta.md": "Mentions PIZZA and [[Unknown Thing|x]].\n",
    "Lonely.md": "# Lonely\n",
    "assets/diagram.png": "png",
  });
});

afterAll(() => vault.remove());

describe("read", () => {
  test("prints the note exactly as stored", async () => {
    expect(await vault.ok("read", "path=Beta.md")).toBe(await vault.read("Beta.md"));
  });

  test("file= finds a note by name like a wikilink does", async () => {
    expect(await vault.ok("read", "file=delta")).toBe("Mentions PIZZA and [[Unknown Thing|x]].\n");
  });

  test("a missing file is an error in the Obsidian CLI's wording", async () => {
    expect(await vault.run("read", "path=Missing.md")).toEqual({
      output: 'Error: File "Missing.md" not found.',
      exitCode: 1,
    });
  });
});

describe("outline", () => {
  test("json lists each heading with level and line number", async () => {
    expect(JSON.parse(await vault.ok("outline", "path=Alpha.md", "format=json"))).toEqual([
      { level: 1, heading: "Alpha", line: 10 },
      { level: 2, heading: "Second heading", line: 16 },
      { level: 3, heading: "Third", line: 18 },
    ]);
  });

  test("the default tree indents headings by level", async () => {
    expect(await vault.ok("outline", "path=Alpha.md")).toBe("Alpha\n  Second heading\n    Third");
  });
});

describe("properties", () => {
  test("json gives the parsed frontmatter", async () => {
    const properties = JSON.parse(await vault.ok("properties", "path=Alpha.md", "format=json"));

    expect(properties).toMatchObject({
      date_created: "2026-10-20 14:05:00",
      rating: 4,
      aliases: ["First", "The Alpha"],
    });
  });

  test("the default yaml format prints the frontmatter as written", async () => {
    expect(await vault.ok("properties", "path=Gamma.md")).toBe("tags: resource/cooking");
  });

  test("property:read prints one value", async () => {
    expect(await vault.ok("property:read", "path=Alpha.md", "name=rating")).toBe("4");
  });
});

describe("tags", () => {
  test("tags of a note include frontmatter and inline tags with a leading hash", async () => {
    expect(await vault.ok("tags", "path=Alpha.md")).toBe("#inbox\n#project/alpha\n#idea");
  });

  test("vault tags with counts as json count notes per tag, as strings like the Obsidian CLI", async () => {
    const tags = JSON.parse(await vault.ok("tags", "counts", "sort=count", "format=json"));

    expect(tags[0]).toEqual({ tag: "#idea", count: "2" });
    expect(tags.map((entry: { tag: string }) => entry.tag)).toContain("#resource/cooking");
  });

  test("tag verbose prints the count and the notes", async () => {
    expect(await vault.ok("tag", "name=idea", "verbose")).toBe("#idea\t2\nAlpha.md\nBeta.md");
  });
});

describe("links", () => {
  test("outgoing links are listed once each in code unit order, with unresolved ones marked", async () => {
    expect(await vault.ok("links", "path=Alpha.md")).toBe(
      [
        "Beta.md",
        "Gamma.md",
        "Missing Prop (unresolved)",
        "Nowhere (unresolved)",
        "assets/diagram.png",
        "folder/Delta.md",
      ].join("\n"),
    );
  });

  test("backlinks with counts as json", async () => {
    expect(JSON.parse(await vault.ok("backlinks", "path=Beta.md", "counts", "format=json"))).toEqual([
      { file: "Alpha.md", count: "3" },
    ]);
  });

  test("a note without backlinks says so", async () => {
    expect(await vault.ok("backlinks", "path=Lonely.md")).toBe("No backlinks found.");
  });

  test("unresolved links with counts and sources as json", async () => {
    expect(JSON.parse(await vault.ok("unresolved", "counts", "verbose", "format=json"))).toEqual([
      { link: "First", count: "1", sources: "Beta.md" },
      { link: "Missing Prop", count: "1", sources: "Alpha.md" },
      { link: "Nowhere", count: "2", sources: "Alpha.md" },
      { link: "Unknown Thing", count: "1", sources: "folder/Delta.md" },
    ]);
  });

  test("aliases verbose pairs each alias with its note", async () => {
    expect(await vault.ok("aliases", "verbose")).toBe("First\tAlpha.md\nThe Alpha\tAlpha.md");
  });

  test("orphans are notes nothing links to", async () => {
    expect(await vault.ok("orphans")).toBe("Lonely.md");
  });
});

describe("files", () => {
  test("files lists every file, and filters by folder and extension", async () => {
    expect(await vault.ok("files", "total")).toBe("6");
    expect(await vault.ok("files", "folder=folder", "ext=md")).toBe("folder/Delta.md");
  });

  test("hidden folders such as .obsidian are not part of the vault", async () => {
    expect(await vault.ok("files")).not.toContain(".obsidian");
  });
});

describe("search", () => {
  test("search lists matching notes, ignoring case", async () => {
    expect(await vault.ok("search", "query=pizza")).toBe("Alpha.md\nBeta.md\nGamma.md\nfolder/Delta.md");
  });

  test("search:context shows the matching lines", async () => {
    expect(JSON.parse(await vault.ok("search:context", "query=pizza dough", "format=json"))).toEqual([
      { file: "Gamma.md", matches: [{ line: 7, text: "Pizza dough. [[Alpha#Second heading]]" }] },
    ]);
  });

  test("a #tag query matches the tag text in notes", async () => {
    expect(await vault.ok("search", "query=#real-tag")).toBe("Beta.md");
  });

  test("nothing found is reported like the Obsidian CLI does", async () => {
    expect(await vault.ok("search", "query=nonexistent")).toBe("No matches found.");
  });
});

describe("arguments", () => {
  test("vault= is accepted before the command, the way the second-brain skill writes it", async () => {
    expect(await vault.ok("vault=notes", "search", "query=dough")).toBe("Gamma.md");
  });
});

describe("unsupported commands", () => {
  test("app-only commands are reported as unsupported", async () => {
    const result = await vault.run("command", "id=obsidian-linter:lint-file");

    expect(result.exitCode).toBe(1);
    expect(result.output).toStartWith('Error: Command "command" is not supported');
  });
});

describe("nested tags and excluded files", () => {
  let nested: TempVault;

  beforeAll(async () => {
    nested = await tempVault(
      {
        "Python.md": "#resource/python #resource/tools",
        "Rust.md": "---\ntags: [resource/rust]\n---\n",
        "Home.md": "#area/home",
        "assets/Drawing.excalidraw.md": "---\ntags: [excalidraw, resource/python]\n---\n[[Python]] pizza",
      },
      { userIgnoreFilters: ["assets/"] },
    );
  });

  afterAll(() => nested.remove());

  test("vault tags include each parent tag, counting the nested tags below it", async () => {
    expect(await nested.ok("tags", "counts")).toBe(
      [
        "#area\t1",
        "#area/home\t1",
        "#resource\t3",
        "#resource/python\t1",
        "#resource/rust\t1",
        "#resource/tools\t1",
      ].join("\n"),
    );
  });

  test("tag lists the notes with the tag or a tag nested below it", async () => {
    expect(await nested.ok("tag", "name=resource", "verbose")).toBe("#resource\t2\nPython.md\nRust.md");
  });

  test("excluded files are left out of tags and search, but their links still count", async () => {
    expect(await nested.ok("tags")).not.toContain("#excalidraw");
    expect(await nested.ok("search", "query=pizza")).toBe("No matches found.");
    expect(await nested.ok("backlinks", "path=Python.md")).toBe("assets/Drawing.excalidraw.md");
  });
});
