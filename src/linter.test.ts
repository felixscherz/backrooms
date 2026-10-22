import { afterEach, describe, expect, test } from "bun:test";
import { runGit } from "./git";
import { tempVault, type TempVault } from "./testing/temp-vault";
import type { GitMode } from "./git";

/** The yaml-timestamp settings of the personal vault's Linter. */
const TIMESTAMPS = {
  enabled: true,
  "date-created": true,
  "date-created-key": "date_created",
  "date-created-source-of-truth": "file system",
  "date-modified": true,
  "date-modified-key": "date_modified",
  "date-modified-source-of-truth": "file system",
  format: "YYYY-MM-DD HH:mm:ss",
  "convert-to-utc": false,
  "update-on-file-contents-updated": "never",
};

/** 12:30 in Berlin. */
const NOW = new Date("2026-10-22T10:30:00Z");

const vaults: TempVault[] = [];

afterEach(async () => {
  for (const vault of vaults.splice(0)) await vault.remove();
});

async function vaultWith(
  files: Record<string, string>,
  options: {
    timestamps?: Record<string, unknown>;
    general?: Record<string, unknown>;
    enabled?: boolean;
    git?: GitMode;
    timeZone?: string;
  } = {},
): Promise<TempVault> {
  const linter = {
    lintOnSave: true,
    ...options.general,
    ruleConfigs: {
      "yaml-timestamp": { ...TIMESTAMPS, ...options.timestamps },
      "trailing-spaces": { enabled: true },
      "header-increment": { enabled: false },
    },
  };
  const vault = await tempVault(
    {
      ".obsidian/community-plugins.json": JSON.stringify(options.enabled === false ? [] : ["obsidian-linter"]),
      ".obsidian/plugins/obsidian-linter/data.json": JSON.stringify(linter),
      ...files,
    },
    {},
    { git: options.git, clock: { now: () => NOW, timeZone: options.timeZone ?? "Europe/Berlin" } },
  );
  vaults.push(vault);
  return vault;
}

describe("the Linter's yaml-timestamp rule", () => {
  test("a created note gets frontmatter with when it was created and modified", async () => {
    const vault = await vaultWith({});

    await vault.ok("create", "path=Pizza.md", "content=# Pizza");

    expect(await vault.read("Pizza.md")).toBe(
      "---\ndate_created: 2026-10-22 12:30:00\ndate_modified: 2026-10-22 12:30:00\n---\n# Pizza",
    );
  });

  test("a save keeps date_created and updates date_modified where it is", async () => {
    const vault = await vaultWith({
      "Note.md": "---\ndate_created: 2026-01-01 08:00:00\ndate_modified: 2026-01-02 08:00:00 \ntags: [a]\n---\nBody",
    });

    await vault.ok("append", "path=Note.md", "content=More");

    expect(await vault.read("Note.md")).toBe(
      "---\ndate_created: 2026-01-01 08:00:00\ndate_modified: 2026-10-22 12:30:00\ntags: [a]\n---\nBody\nMore",
    );
  });

  test("missing timestamps go at the end of the frontmatter, which stays as it was", async () => {
    const vault = await vaultWith({
      "Note.md": "---\ntitle:   x # a comment\ndate_created: 2026-01-01 08:00:00\n---\nBody",
    });

    await vault.ok("edit", "path=Note.md", "old=Body", "new=Text");

    expect(await vault.read("Note.md")).toBe(
      "---\ntitle:   x # a comment\ndate_created: 2026-01-01 08:00:00\ndate_modified: 2026-10-22 12:30:00\n---\nText",
    );
  });

  test("an empty timestamp is filled in", async () => {
    const vault = await vaultWith({ "Note.md": "---\ndate_created:\ndate_modified:\n---\nBody" });

    await vault.ok("property:set", "path=Note.md", "name=status", "value=done");

    expect(await vault.read("Note.md")).toMatch(
      /^---\ndate_created: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\ndate_modified: 2026-10-22 12:30:00\nstatus: done\n---\nBody$/,
    );
  });

  test("a missing or malformed date_created of an existing note becomes the date git first saw the note", async () => {
    const vault = await vaultWith({}, { git: "off" });
    await vault.write("Missing.md", "Body");
    await vault.write("Malformed.md", "---\ndate_created: 202G-01-01 00:00:00\n---\nBody");
    await runGit(vault.root, ["add", "-A"]);
    await runGit(vault.root, [
      ...["-c", "user.name=test", "-c", "user.email=test@localhost"],
      ...["commit", "--quiet", "--date=2025-03-04T05:06:07Z", "-m", "add"],
    ]);

    await vault.ok("append", "path=Missing.md", "content=More");
    await vault.ok("append", "path=Malformed.md", "content=More");

    expect(await vault.read("Missing.md")).toBe(
      "---\ndate_created: 2025-03-04 06:06:07\ndate_modified: 2026-10-22 12:30:00\n---\nBody\nMore",
    );
    expect(await vault.read("Malformed.md")).toBe(
      "---\ndate_created: 2025-03-04 06:06:07\ndate_modified: 2026-10-22 12:30:00\n---\nBody\nMore",
    );
  });

  test("timestamps are local time in the configured time zone, or UTC when the Linter converts them", async () => {
    const tokyo = await vaultWith({}, { timeZone: "Asia/Tokyo" });
    const utc = await vaultWith({}, { timestamps: { "convert-to-utc": true } });

    await tokyo.ok("create", "path=Note.md", "content=x");
    await utc.ok("create", "path=Note.md", "content=x");

    expect(await tokyo.read("Note.md")).toContain("date_created: 2026-10-22 19:30:00\n");
    expect(await utc.read("Note.md")).toContain("date_created: 2026-10-22 10:30:00\n");
  });

  test("the keys and the format come from the Linter's settings", async () => {
    const vault = await vaultWith(
      {},
      { timestamps: { "date-created": false, "date-modified-key": "updated", format: "DD.MM.YY, H:mm [Uhr]" } },
    );

    await vault.ok("create", "path=Note.md", "content=x");

    expect(await vault.read("Note.md")).toBe("---\nupdated: 22.10.26, 12:30 Uhr\n---\nx");
  });

  test("Windows line endings stay", async () => {
    const vault = await vaultWith({ "Note.md": "---\r\ntitle: x\r\n---\r\nBody\r\n" });

    await vault.ok("edit", "path=Note.md", "old=Body", "new=Text");

    expect(await vault.read("Note.md")).toContain("title: x\r\ndate_created: ");
    expect(await vault.read("Note.md")).toEndWith("date_modified: 2026-10-22 12:30:00\r\n---\r\nText\r\n");
  });

  test("nothing happens when the vault does not enable the Linter, or the rule", async () => {
    const disabled = await vaultWith({}, { enabled: false });
    const ruleOff = await vaultWith({}, { timestamps: { enabled: false } });

    await disabled.ok("create", "path=Note.md", "content=x");
    await ruleOff.ok("create", "path=Note.md", "content=x");

    expect(await disabled.read("Note.md")).toBe("x");
    expect(await ruleOff.read("Note.md")).toBe("x");
  });

  test("notes that are only renamed, moved, deleted or have their links updated are not linted", async () => {
    const files = { "A.md": "[[B]]", "B.md": "b" };
    const vault = await vaultWith(files);

    await vault.ok("rename", "path=B.md", "name=C");
    await vault.ok("move", "path=C.md", "to=folder/");
    await vault.ok("delete", "path=A.md");

    expect(await vault.read("folder/C.md")).toBe("b");
    expect(await vault.read(".trash/A.md")).not.toContain("date_");
  });

  test("a write that changes nothing saves nothing", async () => {
    const vault = await vaultWith({ "Note.md": "Body" });

    await vault.ok("edit", "path=Note.md", "old=Body", "new=Body");

    expect(await vault.read("Note.md")).toBe("Body");
  });

  test("writes fail when the Linter's settings ask for something backroom cannot do like the Linter", async () => {
    const format = await vaultWith({}, { timestamps: { format: "MMMM Do YYYY" } });
    const truth = await vaultWith({}, { timestamps: { "date-created-source-of-truth": "frontmatter" } });

    const formatResult = await format.run("create", "path=Note.md", "content=x");
    const truthResult = await truth.run("create", "path=Note.md", "content=x");

    expect(formatResult.output).toContain('format "MMMM Do YYYY"');
    expect(truthResult.output).toContain("frontmatter");
    expect(await format.snapshot()).not.toHaveProperty("Note.md");
  });

  test("a write is linted only when the Linter lints on save, on leaving a note, or as a note changes", async () => {
    const off = { lintOnSave: false, lintOnFileChange: false };
    const vaults = {
      onSave: await vaultWith({}, { general: { ...off, lintOnSave: true } }),
      onLeavingNote: await vaultWith({}, { general: { ...off, lintOnFileChange: true } }),
      asNoteChanges: await vaultWith(
        {},
        { general: off, timestamps: { "update-on-file-contents-updated": "after 5 seconds" } },
      ),
      never: await vaultWith({}, { general: off }),
      defaults: await vaultWith({}, { general: { lintOnSave: undefined } }),
    };

    const linted: Record<string, boolean> = {};
    for (const [name, vault] of Object.entries(vaults)) {
      await vault.ok("create", "path=Note.md", "content=x");
      linted[name] = (await vault.read("Note.md")) !== "x";
    }

    expect(linted).toEqual({ onSave: true, onLeavingNote: true, asNoteChanges: true, never: false, defaults: false });
  });

  test("notes in the folders and files the Linter ignores are left alone", async () => {
    const vault = await vaultWith(
      {},
      {
        general: {
          foldersToIgnore: ["Templates", "/Daily//Old/", ""],
          filesToIgnore: [
            { match: "^Inbox/.*\\.md$", flags: "", label: "inbox" },
            { match: "draft", flags: "i", label: "drafts" },
            { match: "", flags: "", label: "empty matches nothing" },
          ],
        },
      },
    );
    const paths = [
      "Templates/T.md",
      "Templates and more/T.md",
      "Daily/Old/D.md",
      "Daily/D.md",
      "Inbox/I.md",
      "Notes/My DRAFT.md",
      "Notes/Final.md",
    ];

    const linted: string[] = [];
    for (const path of paths) {
      await vault.ok("create", `path=${path}`, "content=x");
      if ((await vault.read(path)) !== "x") linted.push(path);
    }

    expect(linted).toEqual(["Templates and more/T.md", "Daily/D.md", "Notes/Final.md"]);
  });

  test("when date_modified follows user or Linter edits, it changes only when the Linter changes the note", async () => {
    const userOrLinter = { "date-modified-source-of-truth": "user or Linter edits" };
    const vault = await vaultWith(
      {
        "Kept.md": "---\ndate_created: 2026-01-01 08:00:00\ndate_modified: 2026-01-02 08:00:00\n---\nBody",
        "Created.md": "---\ndate_modified: 2026-01-02 08:00:00\n---\nBody",
        "Malformed.md": "---\ndate_created: 2026-01-01 08:00:00\ndate_modified: yesterday\n---\nBody",
        "Missing.md": "---\ndate_created: 2026-01-01 08:00:00\n---\nBody",
      },
      { timestamps: userOrLinter },
    );

    for (const path of ["Kept.md", "Created.md", "Malformed.md", "Missing.md"]) {
      await vault.ok("append", `path=${path}`, "content=More");
    }

    expect(await vault.read("Kept.md")).toContain("date_modified: 2026-01-02 08:00:00\n");
    expect(await vault.read("Created.md")).toContain("date_modified: 2026-10-22 12:30:00\n");
    expect(await vault.read("Malformed.md")).toContain("date_modified: 2026-10-22 12:30:00\n");
    expect(await vault.read("Missing.md")).toContain("date_modified: 2026-10-22 12:30:00\n");
  });

  test("writes fail when a file the Linter ignores is described by an invalid regular expression", async () => {
    const vault = await vaultWith({}, { general: { filesToIgnore: [{ match: "(", flags: "", label: "broken" }] } });

    expect((await vault.run("create", "path=Note.md", "content=x")).output).toContain('"("');
  });
});
