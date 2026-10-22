import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git";
import { tempVault, type TempVault } from "./testing/temp-vault";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

async function gitVault(files: Record<string, string>, mode: "commit" | "sync" = "commit"): Promise<TempVault> {
  const vault = await tempVault(files, {}, { git: mode });
  cleanup.push(() => vault.remove());
  return vault;
}

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await runGit(root, ["-c", "user.name=test", "-c", "user.email=test@localhost", ...args]);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

describe("commits", () => {
  test("every write becomes one commit that names the operation", async () => {
    const vault = await gitVault({ "Pizza.md": "# Pizza\n", "Index.md": "[[Pizza]]\n" });

    await vault.ok("rename", "path=Pizza.md", "name=Pizza Napoletana");

    expect(await git(vault.root, "log", "-1", "--format=%s%n%b")).toBe(
      "backroom: Renamed: Pizza.md -> Pizza Napoletana.md\nBackroom-Operation: rename",
    );
    expect(await git(vault.root, "show", "--name-status", "--format=", "HEAD")).toBe(
      "M\tIndex.md\nR100\tPizza.md\tPizza Napoletana.md",
    );
    expect(await git(vault.root, "status", "--porcelain")).toBe("");
  });

  test("a commit contains only the files the write touched", async () => {
    const vault = await gitVault({ "A.md": "a", "B.md": "b" });
    await vault.write("B.md", "the user's unfinished edit");

    await vault.ok("append", "path=A.md", "content=more");

    expect(await git(vault.root, "show", "--name-only", "--format=", "HEAD")).toBe("A.md");
    expect(await git(vault.root, "status", "--porcelain")).toBe("M B.md");
  });

  test("git:log lists recent commits", async () => {
    const vault = await gitVault({ "A.md": "a" });
    await vault.ok("append", "path=A.md", "content=more");

    const log = await vault.ok("git:log", "limit=1");

    expect(log).toMatch(/^[0-9a-f]+\t\S+\t[^\t]+\tbackroom: Appended to: A.md$/);
  });
});

describe("revert", () => {
  test("reverting a rename restores the old name and the links", async () => {
    const files = { "Pizza.md": "# Pizza\n", "Index.md": "[[Pizza]]\n" };
    const vault = await gitVault(files);
    await vault.ok("rename", "path=Pizza.md", "name=Pizza Napoletana");
    const commit = await git(vault.root, "rev-parse", "--short", "HEAD");

    expect(await vault.ok("git:revert", `commit=${commit}`)).toBe(`Reverted: ${commit}`);

    expect(await vault.read("Index.md")).toBe(files["Index.md"]);
    expect(await vault.ok("files", "ext=md")).toBe("Index.md\nPizza.md");
    expect(await git(vault.root, "diff", "HEAD~2", "HEAD", "--stat")).toBe("");
  });

  test("reverting a delete brings the note back from .trash", async () => {
    const vault = await gitVault({ "Old.md": "keep me" });
    await vault.ok("delete", "path=Old.md");
    const commit = await git(vault.root, "rev-parse", "--short", "HEAD");

    await vault.ok("git:revert", `commit=${commit}`);

    expect(await vault.read("Old.md")).toBe("keep me");
    expect(Object.keys(await vault.snapshot()).filter((path) => path.startsWith(".trash"))).toEqual([]);
  });

  test("a commit whose files changed since is not reverted", async () => {
    const vault = await gitVault({ "A.md": "a" });
    await vault.ok("append", "path=A.md", "content=b");
    const commit = await git(vault.root, "rev-parse", "--short", "HEAD");
    await vault.ok("append", "path=A.md", "content=c");

    const result = await vault.run("git:revert", `commit=${commit}`);

    expect(result.output).toContain("changed since commit");
    expect(await vault.read("A.md")).toBe("a\nb\nc");
  });

  test("commits backroom did not make are not reverted", async () => {
    const vault = await gitVault({ "A.md": "a" });
    const initial = await git(vault.root, "rev-parse", "--short", "HEAD");

    expect((await vault.run("git:revert", `commit=${initial}`)).output).toContain("not made by backroom");
  });
});

describe("sync", () => {
  async function withRemote(files: Record<string, string>) {
    const vault = await gitVault(files, "sync");
    const remote = await mkdtemp(join(tmpdir(), "backroom-remote-"));
    const other = await mkdtemp(join(tmpdir(), "backroom-other-"));
    cleanup.push(() => rm(remote, { recursive: true, force: true }));
    cleanup.push(() => rm(other, { recursive: true, force: true }));
    await git(remote, "init", "--quiet", "--bare");
    await git(vault.root, "remote", "add", "origin", remote);
    await git(vault.root, "push", "--quiet", "-u", "origin", "HEAD");
    await git(other, "clone", "--quiet", remote, ".");
    return { vault, other };
  }

  test("a write pulls first and pushes its commit", async () => {
    const { vault, other } = await withRemote({ "A.md": "a\n" });
    await Bun.write(join(other, "Phone.md"), "from the laptop");
    await git(other, "add", "-A");
    await git(other, "commit", "--quiet", "-m", "vault backup");
    await git(other, "push", "--quiet");

    await vault.ok("append", "path=A.md", "content=b");

    expect(await vault.read("Phone.md")).toBe("from the laptop");
    await git(other, "pull", "--quiet");
    expect(await Bun.file(join(other, "A.md")).text()).toBe("a\n\nb");
  });

  test("a conflicting remote change stops syncing but keeps the local commit", async () => {
    const { vault, other } = await withRemote({ "A.md": "a\n" });
    await vault.ok("append", "path=A.md", "content=local");
    await Bun.write(join(other, "A.md"), "a\nremote\n");
    await git(other, "commit", "--quiet", "-am", "vault backup");
    await git(other, "push", "--quiet", "--force");

    const output = await vault.ok("append", "path=A.md", "content=again");

    expect(await vault.read("A.md")).toBe("a\n\nlocal\nagain");
    expect(output).toContain("Warning: Not pushed");
    expect(await vault.ok("git:status")).toContain("sync: sync (stopped:");
  });
});
