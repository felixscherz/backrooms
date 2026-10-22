import { afterEach, describe, expect, test } from "bun:test";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Clock } from "./clock";
import { createMcpServer } from "./mcp";
import { git, gitRemote } from "./testing/git-remote";
import { tempVault, type TempVault, type TempVaultOptions } from "./testing/temp-vault";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

const BERLIN: Clock = { now: () => new Date("2026-10-22T07:15:00Z"), timeZone: "Europe/Berlin" };

type Connected = { vault: TempVault; client: Client };

async function connect(files: Record<string, string>, options: TempVaultOptions = {}): Promise<Connected> {
  const vault = await tempVault(files, {}, { clock: BERLIN, ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await (await createMcpServer(vault.engine)).connect(serverTransport);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientTransport);
  cleanup.push(async () => {
    await client.close();
    await vault.remove();
  });
  return { vault, client };
}

/** Calls a tool and returns its structured result, failing the test when the tool reports an error. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${text(result)}`);
  return result.structuredContent;
}

/** Calls a tool that is expected to fail and returns its error message. */
async function fails(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return text(result);
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[]).map((part) => part.text).join("");
}

async function setModified(vault: TempVault, path: string, iso: string) {
  const time = new Date(iso);
  await utimes(join(vault.root, path), time, time);
}

describe("tools", () => {
  test("are the ten agent tools, each marked read-only or destructive", async () => {
    const { client } = await connect({});

    const tools = (await client.listTools()).tools;

    expect(
      Object.fromEntries(
        tools.map((tool) => [
          tool.name,
          tool.annotations?.readOnlyHint ? "read" : tool.annotations?.destructiveHint ? "destructive" : "write",
        ]),
      ),
    ).toEqual({
      search: "read",
      list: "read",
      read: "read",
      vault: "read",
      history: "read",
      create: "write",
      edit: "write",
      move: "write",
      delete: "destructive",
      undo: "destructive",
    });
    expect(tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);
  });
});

describe("naming a note", () => {
  test("takes a path, with or without .md, or a name", async () => {
    const { client } = await connect({ "Journal/2026-06 june.md": "June" });

    for (const note of ["Journal/2026-06 june.md", "Journal/2026-06 june", "2026-06 june"]) {
      expect((await call(client, "read", { notes: note })).notes[0]).toMatchObject({
        path: "Journal/2026-06 june.md",
        content: "June",
      });
    }
  });

  test("an exact path wins over a name", async () => {
    const { client } = await connect({ "June.md": "root", "Journal/June.md": "journal" });

    expect((await call(client, "read", { notes: "Journal/June" })).notes[0].content).toBe("journal");
  });

  test("a name that matches several notes is an error that lists them", async () => {
    const { client } = await connect({ "A/June.md": "", "B/June.md": "" });

    expect((await call(client, "read", { notes: "June" })).notes[0]).toEqual({
      note: "June",
      error: '"June" matches 2 notes: A/June.md, B/June.md. Name one by its path.',
    });
  });
});

describe("search", () => {
  const files = {
    "Projects/Oven.md":
      "---\nstatus: open\ndue: 2026-10-20\ntags: [project/oven]\n---\nBuild the oven.\nOrder bricks.\n",
    "Projects/Shed.md": "---\nstatus: done\ndue: 2026-11-05\ntags: [project]\n---\nBuild the shed.\n",
    "Journal/Today.md": "Built nothing.\n",
  };

  test("finds notes by property, comparison and tag, with when each changed", async () => {
    const { vault, client } = await connect(files);
    await setModified(vault, "Projects/Oven.md", "2026-10-21T08:30:00Z");

    expect(await call(client, "search", { query: "[status:open] tag:#project" })).toEqual({
      notes: [{ path: "Projects/Oven.md", modified: "2026-10-21T10:30:00+02:00" }],
      more: false,
    });
    expect((await call(client, "search", { query: "[due:>2026-11-01]" })).notes.map((n: any) => n.path)).toEqual([
      "Projects/Shed.md",
    ]);
  });

  test("limit caps the notes and says there are more, and context adds the matching lines", async () => {
    const { client } = await connect(files);

    const result = await call(client, "search", { query: "build", limit: 1, context: "lines" });

    expect(result).toEqual({
      notes: [
        { path: "Projects/Oven.md", modified: expect.any(String), lines: [{ line: 6, text: "Build the oven." }] },
      ],
      more: true,
    });
  });

  test("folder narrows the search", async () => {
    const { client } = await connect(files);

    expect((await call(client, "search", { query: "built", folder: "Projects" })).notes).toEqual([]);
  });
});

describe("list", () => {
  test("lists notes by name, or the most recently changed first", async () => {
    const { vault, client } = await connect({ "A.md": "", "B.md": "", "C.md": "", "image.png": "" });
    await setModified(vault, "A.md", "2026-10-01T00:00:00Z");
    await setModified(vault, "B.md", "2026-10-21T00:00:00Z");
    await setModified(vault, "C.md", "2026-10-11T00:00:00Z");

    expect((await call(client, "list")).items.map((item: any) => item.path)).toEqual(["A.md", "B.md", "C.md"]);
    expect(await call(client, "list", { sort: "modified", limit: 2 })).toEqual({
      items: [
        { path: "B.md", modified: "2026-10-21T02:00:00+02:00" },
        { path: "C.md", modified: "2026-10-11T02:00:00+02:00" },
      ],
      total: 3,
    });
  });

  test("lists folders", async () => {
    const { client } = await connect({ "Journal/2026/June.md": "", "Projects/Oven.md": "" });

    expect(await call(client, "list", { kind: "folders", folder: "Journal" })).toEqual({
      items: [{ path: "Journal" }, { path: "Journal/2026" }],
      total: 2,
    });
  });
});

describe("read", () => {
  test("reads several notes in one call, each with its version and modification time", async () => {
    const { client } = await connect({ "A.md": "---\nstatus: open\n---\nAlpha\n", "B.md": "Beta\n" });

    const { notes } = await call(client, "read", { notes: ["A", "B.md", "Missing"] });

    expect(notes).toEqual([
      {
        note: "A",
        path: "A.md",
        version: expect.stringMatching(/^[0-9a-f]{16}$/),
        modified: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/),
        content: "---\nstatus: open\n---\nAlpha\n",
        properties: { status: "open" },
      },
      expect.objectContaining({ note: "B.md", content: "Beta\n", properties: {} }),
      { note: "Missing", error: 'File "Missing" not found.' },
    ]);
  });

  test("include returns the outline, links and backlinks instead", async () => {
    const { client } = await connect({ "A.md": "# Alpha\nSee [[B]] and [[Nowhere]].\n", "B.md": "Back to [[A]].\n" });

    const [note] = (await call(client, "read", { notes: "A", include: ["outline", "links", "backlinks"] })).notes;

    expect(note).toEqual({
      note: "A",
      path: "A.md",
      version: expect.any(String),
      modified: expect.any(String),
      outline: [{ level: 1, heading: "Alpha", line: 1 }],
      links: [
        { target: "B.md", resolved: true },
        { target: "Nowhere", resolved: false },
      ],
      backlinks: [{ note: "B.md", count: 1 }],
    });
  });

  describe("a section", () => {
    const journal =
      "# 2026\n## June\n### Monday\nRan.\n### Tuesday\nSwam.\n## July\n### Monday\nRested.\n```\n# not a heading\n```\n";

    test("is the text under its heading, up to the next heading of the same or a higher level", async () => {
      const { client } = await connect({ "Journal.md": journal });

      const [note] = (await call(client, "read", { notes: "Journal", section: "June" })).notes;

      expect(note.content).toBe("## June\n### Monday\nRan.\n### Tuesday\nSwam.\n");
      expect(note.section).toEqual({ heading: "2026 > June", line: 2 });
    });

    test("is named by a path of headings when several headings have the same text", async () => {
      const { client } = await connect({ "Journal.md": journal });

      const [note] = (await call(client, "read", { notes: "Journal", section: "July > Monday" })).notes;

      expect(note.content).toBe("### Monday\nRested.\n```\n# not a heading\n```\n");
    });

    test("that matches several headings is an error listing each with its line", async () => {
      const { client } = await connect({ "Journal.md": journal });

      const [note] = (await call(client, "read", { notes: "Journal", section: "Monday" })).notes;

      expect(note.error).toBe(
        '"Monday" matches 2 headings in "Journal.md": 2026 > June > Monday (line 3); 2026 > July > Monday (line 8). ' +
          "Name one by its path.",
      );
    });
  });
});

describe("vault", () => {
  test("reports properties, tags, aliases and health", async () => {
    const { client } = await connect({
      "A.md": "---\nstatus: open\naliases: [Alpha]\ntags: [project/oven]\n---\nSee [[Missing]].\n",
      "B.md": "Nothing.\n",
      "image.png": "",
    });

    expect((await call(client, "vault", { report: "properties" })).properties).toContainEqual({
      name: "status",
      type: "text",
      count: 1,
    });
    expect((await call(client, "vault", { report: "tags" })).tags).toEqual([
      { tag: "#project", count: 1 },
      { tag: "#project/oven", count: 1 },
    ]);
    expect((await call(client, "vault", { report: "aliases" })).aliases).toEqual([{ alias: "Alpha", note: "A.md" }]);
    expect((await call(client, "vault", { report: "health" })).health).toEqual({
      unresolved: [{ link: "Missing", count: 1, sources: ["A.md"] }],
      orphans: ["A.md", "B.md", "image.png"],
      deadends: ["B.md"],
    });
  });
});

describe("create", () => {
  test("creates a note and returns its path and version", async () => {
    const { vault, client } = await connect({});

    const result = await call(client, "create", { note: "Projects/Oven", content: "# Oven\n" });

    expect(result).toEqual({
      summary: "Created: Projects/Oven.md",
      path: "Projects/Oven.md",
      version: expect.any(String),
      warnings: [],
    });
    expect(await vault.read("Projects/Oven.md")).toBe("# Oven\n");
    const [read] = (await call(client, "read", { notes: "Projects/Oven.md" })).notes;
    expect(read.version).toBe(result.version);
  });

  test("fails when the note exists, instead of picking another name", async () => {
    const { client } = await connect({ "Oven.md": "" });

    expect(await fails(client, "create", { note: "Oven" })).toBe(
      'Error: "Oven.md" already exists. Change it with edit instead.',
    );
  });
});

describe("edit", () => {
  test("applies several changes in order as one write", async () => {
    const { vault, client } = await connect(
      { "Log.md": "---\nstatus: open # keep\n---\n# Log\n## Today\n- woke up\n## Later\n" },
      { git: "commit" },
    );
    const commitsBefore = await git(vault.root, "rev-list", "--count", "HEAD");

    await call(client, "edit", {
      note: "Log",
      changes: [
        { op: "replace", old: "- woke up\n", new: "- woke up\n- had coffee\n" },
        { op: "set_property", name: "status", value: "done" },
        { op: "set_property", name: "tags", value: ["log", "daily"] },
        { op: "set_property", name: "count", value: 3 },
        { op: "append", content: "- went to bed" },
        { op: "prepend", content: "Daily log." },
      ],
    });

    expect(await vault.read("Log.md")).toBe(
      "---\nstatus: done # keep\ntags:\n  - log\n  - daily\ncount: 3\n---\nDaily log.\n# Log\n## Today\n- woke up\n" +
        "- had coffee\n## Later\n- went to bed",
    );
    expect(Number(await git(vault.root, "rev-list", "--count", "HEAD"))).toBe(Number(commitsBefore) + 1);
  });

  test("applies none of the changes when one fails, and names it", async () => {
    const { vault, client } = await connect({ "Log.md": "a\nb\na\n" });

    const error = await fails(client, "edit", {
      note: "Log",
      changes: [
        { op: "append", content: "c" },
        { op: "replace", old: "a", new: "x" },
      ],
    });

    expect(error).toBe(
      "Error: Change 2 (replace): The text to replace occurs 2 times, at lines 1, 3. Include surrounding text to " +
        "make it unique, or set all to replace every occurrence. Nothing was changed.",
    );
    expect(await vault.read("Log.md")).toBe("a\nb\na\n");
  });

  test("is rejected when the note changed since the version that was read", async () => {
    const { vault, client } = await connect({ "Log.md": "a\n" });
    const [{ version }] = (await call(client, "read", { notes: "Log" })).notes;
    await vault.write("Log.md", "a\nchanged elsewhere\n");

    const error = await fails(client, "edit", { note: "Log", version, changes: [{ op: "append", content: "b" }] });

    expect(error).toBe(`Error: File "Log.md" changed since version ${version}. Read it again and retry the change.`);
  });

  test("set_content replaces the text after the frontmatter", async () => {
    const { vault, client } = await connect({ "Oven.md": "---\nstatus: open # keep\n---\n# Oven\nold plan\n" });

    await call(client, "edit", { note: "Oven", changes: [{ op: "set_content", content: "# Oven\n\nnew plan\n" }] });

    expect(await vault.read("Oven.md")).toBe("---\nstatus: open # keep\n---\n# Oven\n\nnew plan\n");
  });

  test("set_content refuses frontmatter, which set_property changes", async () => {
    const { vault, client } = await connect({ "Oven.md": "# Oven\n" });

    const error = await fails(client, "edit", {
      note: "Oven",
      changes: [{ op: "set_content", content: "---\nstatus: done\n---\n# Oven\n" }],
    });

    expect(error).toBe(
      "Error: The content must not start with frontmatter. Change properties with set_property instead.",
    );
    expect(await vault.read("Oven.md")).toBe("# Oven\n");
  });

  test("append_to_section adds text under the heading's own text, before its subsections", async () => {
    const { vault, client } = await connect({
      "Oven.md": "# Oven\n## Tasks\n- buy bricks\n\n### Later\n- paint\n## Notes\n",
    });

    await call(client, "edit", {
      note: "Oven",
      changes: [{ op: "append_to_section", heading: "Tasks", content: "- lay the floor" }],
    });

    expect(await vault.read("Oven.md")).toBe(
      "# Oven\n## Tasks\n- buy bricks\n- lay the floor\n\n### Later\n- paint\n## Notes\n",
    );
  });

  test("append_to_section adds a subsection after the section's last one", async () => {
    const { vault, client } = await connect({
      "Journal.md": "# June\n## 2026-06-22\n- rain\n\n# July\n",
    });

    await call(client, "edit", {
      note: "Journal",
      changes: [{ op: "append_to_section", heading: "June", content: "## 2026-06-23\n- sun\n" }],
    });

    expect(await vault.read("Journal.md")).toBe("# June\n## 2026-06-22\n- rain\n## 2026-06-23\n- sun\n\n# July\n");
  });

  test("append_to_section adds to a section at the end of a note without a final line break", async () => {
    const { vault, client } = await connect({ "Oven.md": "# Oven\n## Tasks" });

    await call(client, "edit", {
      note: "Oven",
      changes: [{ op: "append_to_section", heading: "Tasks", content: "- buy bricks" }],
    });

    expect(await vault.read("Oven.md")).toBe("# Oven\n## Tasks\n- buy bricks\n");
  });

  test("append_to_section fails when the heading matches several sections, and lists them", async () => {
    const { vault, client } = await connect({ "Journal.md": "# June\n## Tasks\n# July\n## Tasks\n" });

    const error = await fails(client, "edit", {
      note: "Journal",
      changes: [{ op: "append_to_section", heading: "Tasks", content: "- x" }],
    });

    expect(error).toBe(
      'Error: "Tasks" matches 2 headings in "Journal.md": June > Tasks (line 2); July > Tasks (line 4). ' +
        "Name one by its path.",
    );
    expect(await vault.read("Journal.md")).toBe("# June\n## Tasks\n# July\n## Tasks\n");
  });

  test("returns the version for the next write", async () => {
    const { client } = await connect({ "Log.md": "a\n" });

    const first = await call(client, "edit", { note: "Log", changes: [{ op: "append", content: "b" }] });
    const second = await call(client, "edit", {
      note: "Log",
      version: first.version,
      changes: [{ op: "append", content: "c" }],
    });

    expect(second.summary).toBe("Edited: Log.md (1 change)");
  });
});

describe("move", () => {
  test("moves to a folder it creates, renames, and updates links", async () => {
    const { vault, client } = await connect({ "Oven.md": "oven", "Index.md": "[[Oven]]\n" });

    const result = await call(client, "move", { note: "Oven", folder: "Projects/Kitchen", name: "Pizza oven" });

    expect(result).toMatchObject({ path: "Projects/Kitchen/Pizza oven.md", version: expect.any(String) });
    expect(await vault.read("Projects/Kitchen/Pizza oven.md")).toBe("oven");
    expect(await vault.read("Index.md")).toBe("[[Pizza oven]]\n");
  });
});

describe("delete and undo", () => {
  test("delete moves a note to the trash, and undo brings it back", async () => {
    const { vault, client } = await connect({ "Oven.md": "oven" }, { git: "commit" });

    await call(client, "delete", { note: "Oven" });
    const [commit] = (await call(client, "history", { limit: 1 })).commits;
    await call(client, "undo", { commit: commit.id });

    expect(await vault.read("Oven.md")).toBe("oven");
  });
});

describe("history", () => {
  test("without arguments, gives the sync state in words and the latest commits", async () => {
    const { client } = await connect({ "A.md": "a" }, { git: "commit" });
    await call(client, "edit", { note: "A", changes: [{ op: "append", content: "b" }] });

    const result = await call(client, "history", {});

    expect(result.sync).toBe("sync off, every write is committed but not pushed, nothing uncommitted");
    expect(result.commits.map((commit: any) => commit.message)).toEqual([
      "backrooms: Edited: A.md (1 change)",
      "initial",
    ]);
    expect(result.commits[0].time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+0[12]:00$/);
  });

  test("in sync mode, says when it last pulled and pushed", async () => {
    const { vault, client } = await connect({ "A.md": "a" }, { git: "sync" });
    const remote = await gitRemote(vault.root);
    cleanup.push(() => remote.remove());
    await call(client, "edit", { note: "A", changes: [{ op: "append", content: "b" }] });
    await vault.write("Draft.md", "draft");

    expect((await call(client, "history", {})).sync).toBe(
      "sync on, last pull less than a minute ago, last push less than a minute ago, 1 file uncommitted: Draft.md",
    );
  });

  test("with a note, lists its commits, and with a commit, shows what it changed", async () => {
    const { client } = await connect({ "A.md": "a", "B.md": "b" }, { git: "commit" });
    await call(client, "edit", { note: "A", changes: [{ op: "append", content: "more" }] });
    await call(client, "edit", { note: "B", changes: [{ op: "append", content: "more" }] });

    const { commits } = await call(client, "history", { note: "A" });
    const { commit } = await call(client, "history", { commit: commits[0].id });

    expect(commits.map((entry: any) => entry.message)).toEqual(["backrooms: Edited: A.md (1 change)", "initial"]);
    expect(commit.files).toEqual([{ path: "A.md", status: "modified" }]);
    expect(commit.patch).toContain("+more");
  });

  test("without git, says there is no history", async () => {
    const { client } = await connect({});

    expect(await call(client, "history", {})).toEqual({
      sync: "The vault is not a git repository, so there is no history.",
      commits: [],
    });
  });
});

describe("server instructions", () => {
  test("explain the tools and add the vault's conventions from AGENTS.md", async () => {
    const { client } = await connect({ "AGENTS.md": "Monthly notes are named YYYY-MM month.\n" });

    const instructions = client.getInstructions()!;

    expect(instructions).toContain("Read notes with read");
    expect(instructions).toEndWith(
      "## Conventions of this vault, from AGENTS.md\n\nMonthly notes are named YYYY-MM month.",
    );
  });

  test("are only the fixed text without AGENTS.md", async () => {
    const { client } = await connect({});

    expect(client.getInstructions()).not.toContain("Conventions");
  });
});

describe("errors", () => {
  test("are tool errors with the engine's message", async () => {
    const { client } = await connect({});

    expect(await fails(client, "edit", { note: "Missing", changes: [{ op: "append", content: "x" }] })).toBe(
      'Error: File "Missing" not found.',
    );
  });

  test("content is taken literally, without \\n escapes", async () => {
    const { vault, client } = await connect({});

    await call(client, "create", { note: "Code", content: "line one\nprint('\\n')" });

    expect(await vault.read("Code.md")).toBe("line one\nprint('\\n')");
  });
});
