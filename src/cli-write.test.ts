import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tempVault, type TempVault } from "./testing/temp-vault";
import { contentVersion } from "./vault";
import { applyChanges } from "./write";

const vaults: TempVault[] = [];

async function vaultWith(files: Record<string, string>, settings: Record<string, unknown> = {}): Promise<TempVault> {
  const vault = await tempVault(files, settings);
  vaults.push(vault);
  return vault;
}

afterEach(async () => {
  for (const vault of vaults.splice(0)) await vault.remove();
});

/** The files that differ between two snapshots. */
function changedPaths(before: Record<string, string>, after: Record<string, string>): string[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((path) => before[path] !== after[path]).sort();
}

describe("create", () => {
  test("creates a note with the given content, turning \\n into newlines", async () => {
    const vault = await vaultWith({});

    expect(await vault.ok("create", "path=Ideas/Pizza.md", "content=# Pizza\\n\\nDough")).toBe(
      "Created: Ideas/Pizza.md",
    );
    expect(await vault.read("Ideas/Pizza.md")).toBe("# Pizza\n\nDough");
  });

  test("a name without extension becomes a markdown note at the vault root", async () => {
    const vault = await vaultWith({});

    expect(await vault.ok("create", "name=Pizza")).toBe("Created: Pizza.md");
  });

  test("never replaces an existing note, also when only the case differs", async () => {
    const vault = await vaultWith({ "Pizza.md": "mine" });

    expect(await vault.run("create", "path=pizza.md", "content=x")).toEqual({
      output: 'Error: File "Pizza.md" already exists.',
      exitCode: 1,
    });
    expect(await vault.read("Pizza.md")).toBe("mine");
  });

  test("overwrite needs the version of the note it replaces", async () => {
    const vault = await vaultWith({ "Pizza.md": "mine" });

    expect((await vault.run("create", "path=Pizza.md", "content=x", "overwrite")).exitCode).toBe(1);
    expect((await vault.run("create", "path=Pizza.md", "content=x", "overwrite", "version=0000")).output).toContain(
      "changed since",
    );
    expect(
      await vault.ok("create", "path=Pizza.md", "content=new", "overwrite", `version=${contentVersion("mine")}`),
    ).toBe("Overwrote: Pizza.md");
    expect(await vault.read("Pizza.md")).toBe("new");
  });

  test("names Obsidian cannot link to and hidden folders are rejected", async () => {
    const vault = await vaultWith({});

    expect((await vault.run("create", "path=What?.md")).exitCode).toBe(1);
    expect((await vault.run("create", "path=Note#1.md")).exitCode).toBe(1);
    expect((await vault.run("create", "path=.obsidian/evil.md")).exitCode).toBe(1);
    expect((await vault.run("create", "path=../outside.md")).exitCode).toBe(1);
  });
});

describe("property:set", () => {
  const note = [
    "---",
    "# a comment that must survive",
    "date_created: 2026-10-20 14:05:00",
    "tags: [inbox]   # flow style kept",
    "rating: 4",
    "---",
    "# Body",
    "",
  ].join("\n");

  test("changes only the bytes of the value", async () => {
    const vault = await vaultWith({ "Note.md": note });

    expect(await vault.ok("property:set", "path=Note.md", "name=rating", "value=5", "type=number")).toBe(
      "Set rating: 5",
    );
    expect(await vault.read("Note.md")).toBe(note.replace("rating: 4", "rating: 5"));
  });

  test("a new property is added as the last line of the frontmatter", async () => {
    const vault = await vaultWith({ "Note.md": note });

    await vault.ok("property:set", "path=Note.md", "name=last_reviewed", "value=2026-10-21", "type=date");

    expect(await vault.read("Note.md")).toBe(note.replace("rating: 4\n", "rating: 4\nlast_reviewed: 2026-10-21\n"));
  });

  test("a list is written in block style, the way Obsidian writes lists", async () => {
    const vault = await vaultWith({ "Note.md": note });

    await vault.ok("property:set", "path=Note.md", "name=tags", "value=inbox, resource/cooking", "type=list");

    expect(await vault.read("Note.md")).toBe(note.replace("tags: [inbox]", "tags:\n  - inbox\n  - resource/cooking"));
  });

  test("a note without frontmatter gets one", async () => {
    const vault = await vaultWith({ "Plain.md": "# Plain\n" });

    await vault.ok("property:set", "path=Plain.md", "name=status", "value=draft");

    expect(await vault.read("Plain.md")).toBe("---\nstatus: draft\n---\n# Plain\n");
  });

  test("text that YAML would read as another type is quoted", async () => {
    const vault = await vaultWith({ "Plain.md": "" });

    await vault.ok("property:set", "path=Plain.md", "name=answer", "value=true", "type=text");

    expect(await vault.read("Plain.md")).toBe('---\nanswer: "true"\n---\n');
  });

  test("without a type, a list property stays a list", async () => {
    const vault = await vaultWith({ "Note.md": "---\naliases:\n  - A\n---\n" });

    await vault.ok("property:set", "path=Note.md", "name=aliases", "value=A, B");

    expect(await vault.read("Note.md")).toBe("---\naliases:\n  - A\n  - B\n---\n");
  });

  test("windows line endings are kept", async () => {
    const vault = await vaultWith({ "Note.md": "---\r\na: 1\r\n---\r\nBody\r\n" });

    await vault.ok("property:set", "path=Note.md", "name=b", "value=2", "type=number");

    expect(await vault.read("Note.md")).toBe("---\r\na: 1\r\nb: 2\r\n---\r\nBody\r\n");
  });

  test("a datetime has to be in ISO format, with the Obsidian CLI's error message", async () => {
    const vault = await vaultWith({ "Note.md": note });

    expect(
      await vault.run("property:set", "path=Note.md", "name=d", "value=2026-10-21 16:40:00", "type=datetime"),
    ).toEqual({
      output: "Error: Invalid datetime format. Use YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss",
      exitCode: 1,
    });
    expect(await vault.read("Note.md")).toBe(note);
  });

  test("a note whose frontmatter cannot be read is not touched", async () => {
    const broken = "---\ntitle: [unclosed\n---\nBody\n";
    const vault = await vaultWith({ "Broken.md": broken });

    const result = await vault.run("property:set", "path=Broken.md", "name=a", "value=1");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("cannot be changed safely");
    expect(await vault.read("Broken.md")).toBe(broken);
  });

  test("property:remove removes the property's lines only", async () => {
    const vault = await vaultWith({ "Note.md": note });

    await vault.ok("property:remove", "path=Note.md", "name=tags");

    expect(await vault.read("Note.md")).toBe(note.replace("tags: [inbox]   # flow style kept\n", ""));
  });
});

describe("append, prepend and edit", () => {
  test("append adds content on a new line", async () => {
    const vault = await vaultWith({ "Log.md": "# Log\n- first\n" });

    expect(await vault.ok("append", "path=Log.md", "content=- second")).toBe("Appended to: Log.md");
    expect(await vault.read("Log.md")).toBe("# Log\n- first\n- second\n");
  });

  test("prepend adds content after the frontmatter", async () => {
    const vault = await vaultWith({ "Log.md": "---\na: 1\n---\n# Log\n" });

    await vault.ok("prepend", "path=Log.md", "content=Summary");

    expect(await vault.read("Log.md")).toBe("---\na: 1\n---\nSummary\n# Log\n");
  });

  test("edit replaces text that occurs exactly once", async () => {
    const vault = await vaultWith({ "Note.md": "## October\n- one\n\n## November\n" });

    expect(await vault.ok("edit", "path=Note.md", "old=- one\\n", "new=- one\\n- two\\n")).toBe(
      "Edited: Note.md (1 replacement)",
    );
    expect(await vault.read("Note.md")).toBe("## October\n- one\n- two\n\n## November\n");
  });

  test("edit refuses ambiguous text unless all occurrences are meant", async () => {
    const vault = await vaultWith({ "Note.md": "a a" });

    expect((await vault.run("edit", "path=Note.md", "old=a", "new=b")).output).toContain("occurs 2 times");
    expect(await vault.ok("edit", "path=Note.md", "old=a", "new=b", "all")).toBe("Edited: Note.md (2 replacements)");
  });

  test("a write based on an old version is rejected", async () => {
    const vault = await vaultWith({ "Note.md": "original" });
    const { version } = await vault.engine.read({ path: "Note.md" });
    await vault.write("Note.md", "changed by someone else");

    const result = await vault.run("edit", "path=Note.md", "old=changed", "new=mine", `version=${version}`);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("changed since version");
    expect(await vault.read("Note.md")).toBe("changed by someone else");
  });
});

describe("delete", () => {
  test("moves the file to .trash instead of deleting it", async () => {
    const vault = await vaultWith({ "Old.md": "old", ".trash/Old.md": "older" });

    expect(await vault.ok("delete", "path=Old.md")).toBe("Moved to trash: Old.md");
    expect(await vault.snapshot()).toMatchObject({ ".trash/Old.md": "older", ".trash/Old 1.md": "old" });
    expect((await vault.ok("files")).split("\n")).not.toContain("Old.md");
  });

  test("permanent deletion is not supported", async () => {
    const vault = await vaultWith({ "Old.md": "old" });

    expect((await vault.run("delete", "path=Old.md", "permanent")).exitCode).toBe(1);
    expect(await vault.read("Old.md")).toBe("old");
  });
});

describe("rename and move", () => {
  const files = {
    "Pizza.md": "# Pizza\n",
    "Index.md": [
      "---",
      'related: ["[[Pizza]]", "[[Other]]"]',
      "---",
      "Plain [[Pizza]], aliased [[Pizza|the pizza]], heading [[Pizza#Dough]], block [[Pizza#^b1]].",
      "Embedded ![[Pizza]] and markdown [link](Pizza.md#Dough). Unrelated [[Other]].",
      "`[[Pizza]]` in code stays.",
      "",
    ].join("\n"),
    "Other.md": "| [[Pizza\\|table alias]] |\n",
  };

  test("rename updates every kind of link and nothing else", async () => {
    const vault = await vaultWith(files);
    const before = await vault.snapshot();

    expect(await vault.ok("rename", "path=Pizza.md", "name=Pizza Napoletana")).toBe(
      "Renamed: Pizza.md -> Pizza Napoletana.md",
    );

    const after = await vault.snapshot();
    expect(changedPaths(before, after)).toEqual(["Index.md", "Other.md", "Pizza Napoletana.md", "Pizza.md"]);
    expect(after["Index.md"]).toBe(
      files["Index.md"]
        .replace('"[[Pizza]]"', '"[[Pizza Napoletana]]"')
        .replace("Plain [[Pizza]]", "Plain [[Pizza Napoletana]]")
        .replace("[[Pizza|the pizza]]", "[[Pizza Napoletana|the pizza]]")
        .replace("[[Pizza#Dough]]", "[[Pizza Napoletana#Dough]]")
        .replace("[[Pizza#^b1]]", "[[Pizza Napoletana#^b1]]")
        .replace("![[Pizza]]", "![[Pizza Napoletana]]")
        .replace("(Pizza.md#Dough)", "(Pizza%20Napoletana.md#Dough)"),
    );
    expect(after["Other.md"]).toBe("| [[Pizza Napoletana\\|table alias]] |\n");
    expect(after["Pizza Napoletana.md"]).toBe("# Pizza\n");
  });

  test("a rename that only changes case works on case-insensitive disks", async () => {
    const vault = await vaultWith({ "paris 2024.md": "x", "Trips.md": "[[paris 2024]]" });

    expect(await vault.ok("rename", "path=paris 2024.md", "name=Paris 2024.md")).toBe(
      "Renamed: paris 2024.md -> Paris 2024.md",
    );
    expect(await vault.ok("files")).toBe("Paris 2024.md\nTrips.md");
    expect(await vault.read("Trips.md")).toBe("[[Paris 2024]]");
  });

  test("a rename onto an existing note is refused", async () => {
    const vault = await vaultWith(files);
    const before = await vault.snapshot();

    expect((await vault.run("rename", "path=Pizza.md", "name=Other")).output).toBe(
      'Error: File "Other.md" already exists.',
    );
    expect(await vault.snapshot()).toEqual(before);
  });

  test("move to a folder keeps the name and updates links", async () => {
    const vault = await vaultWith({ "Pizza.md": "x", "Index.md": "[[Pizza]] [m](Pizza.md)" });

    expect(await vault.ok("move", "path=Pizza.md", "to=Recipes/")).toBe("Moved: Pizza.md -> Recipes/Pizza.md");
    expect(await vault.read("Index.md")).toBe("[[Pizza]] [m](Pizza.md)");
    expect(await vault.ok("links", "path=Index.md")).toBe("Recipes/Pizza.md");
  });

  test("links inside the moved note keep pointing at the same files", async () => {
    const vault = await vaultWith({
      "notes/Pizza.md": "[sibling](Dough.md) [[Dough]]",
      "notes/Dough.md": "",
      "elsewhere/Dough.md": "",
    });

    await vault.ok("move", "path=notes/Pizza.md", "to=elsewhere/deep/Pizza.md");

    expect(await vault.ok("links", "path=elsewhere/deep/Pizza.md")).toBe("notes/Dough.md");
  });

  test("a link to another note that the move would redirect is rewritten to keep its target", async () => {
    const vault = await vaultWith({
      "a/Topic.md": "",
      "c/deep/Topic.md": "",
      "b/Source.md": "[[Topic]]",
    });

    await vault.ok("move", "path=c/deep/Topic.md", "to=b/Topic.md");

    expect(await vault.read("b/Source.md")).toBe("[[a/Topic]]");
    expect(await vault.ok("links", "path=b/Source.md")).toBe("a/Topic.md");
  });

  test("relative link format writes links relative to the linking note", async () => {
    const vault = await vaultWith({ "Pizza.md": "", "Index.md": "[[Pizza]]" }, { newLinkFormat: "relative" });

    await vault.ok("move", "path=Pizza.md", "to=Recipes/Pizza.md");

    expect(await vault.read("Index.md")).toBe("[[Recipes/Pizza]]");
  });
});

describe("the write path", () => {
  test("a change that fails part way restores the files it already wrote", async () => {
    const vault = await vaultWith({ "A.md": "a" });
    await mkdir(join(vault.root, "Locked"));
    await chmod(join(vault.root, "Locked"), 0o555);

    try {
      const attempt = applyChanges(vault.root, [
        { kind: "modify", path: "A.md", baseVersion: contentVersion("a"), text: "changed" },
        { kind: "create", path: "Locked/B.md", text: "b" },
      ]);
      expect(attempt).rejects.toThrow();
      await attempt.catch(() => {});
      expect(await vault.read("A.md")).toBe("a");
    } finally {
      await chmod(join(vault.root, "Locked"), 0o755);
    }
  });

  test("no file is written when any change is based on an outdated version", async () => {
    const vault = await vaultWith({ "A.md": "a", "B.md": "b" });

    const attempt = applyChanges(vault.root, [
      { kind: "modify", path: "A.md", baseVersion: contentVersion("a"), text: "changed" },
      { kind: "modify", path: "B.md", baseVersion: contentVersion("outdated"), text: "changed" },
    ]);

    expect(attempt).rejects.toThrow("changed since version");
    await attempt.catch(() => {});
    expect(await vault.read("A.md")).toBe("a");
  });

  test("no temporary files are left behind", async () => {
    const vault = await vaultWith({ "A.md": "---\na: 1\n---\n" });

    await vault.ok("property:set", "path=A.md", "name=a", "value=2");
    await vault.ok("rename", "path=A.md", "name=B");

    expect(Object.keys(await vault.snapshot()).filter((path) => !path.startsWith(".obsidian"))).toEqual(["B.md"]);
  });
});

describe("file permissions", () => {
  test("a modified file keeps its permissions", async () => {
    const vault = await vaultWith({ "Script.md": "a" });
    await chmod(join(vault.root, "Script.md"), 0o600);

    await vault.ok("append", "path=Script.md", "content=b");

    expect((await stat(join(vault.root, "Script.md"))).mode & 0o777).toBe(0o600);
  });
});
