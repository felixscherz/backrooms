import { BackroomError } from "./errors";
import type { WriteResult } from "./engine";

/**
 * How backroom uses git (ADR 6). `off` leaves git alone, `commit` records every write as one commit, `sync` also
 * pulls before each write and pushes after each commit.
 */
export type GitMode = "off" | "commit" | "sync";

export type GitResult = { exitCode: number; stdout: string; stderr: string };

/** Runs the git executable. A seam so tests and callers can see exactly what backroom asks git to do. */
export type GitRunner = (cwd: string, args: string[]) => Promise<GitResult>;

export const runGit: GitRunner = async (cwd, args) => {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
};

/** The trailer that marks a commit as made by backroom, so revert only touches backroom's own commits. */
export const OPERATION_TRAILER = "Backroom-Operation";

const FALLBACK_IDENTITY = ["-c", "user.name=backroom", "-c", "user.email=backroom@localhost"];

export class Git {
  /** Set when a sync failed in a way a human has to resolve. Writes keep working locally in the meantime. */
  private blocked: string | null = null;

  constructor(
    private readonly root: string,
    readonly mode: GitMode,
    private readonly run: GitRunner = runGit,
  ) {}

  /** Brings in changes from the remote before a write, so the write is planned against the latest vault. */
  async beforeWrite(): Promise<void> {
    if (this.mode !== "sync" || this.blocked) return;
    const failure = await this.pullRebase();
    if (failure) this.blocked = failure;
  }

  /**
   * Rebases local commits onto the remote branch. Without fork-point detection, so a local commit is never dropped
   * because the remote history was rewritten. Returns why it failed, after restoring the state before the rebase.
   */
  private async pullRebase(): Promise<string | null> {
    const fetch = await this.run(this.root, ["fetch", "--quiet"]);
    if (fetch.exitCode !== 0) return `git fetch failed: ${firstLine(fetch.stderr)}`;
    const upstream = await this.run(this.root, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
    if (upstream.exitCode !== 0) return "the branch has no upstream to sync with";
    const rebase = await this.run(this.root, ["rebase", "--quiet", "--no-fork-point", "--autostash", "@{upstream}"]);
    if (rebase.exitCode === 0) return null;
    await this.run(this.root, ["rebase", "--abort"]);
    return `rebase onto the remote failed: ${firstLine(rebase.stderr || rebase.stdout)}`;
  }

  /** Commits exactly the files a write touched, and pushes in sync mode. Returns warnings for the caller. */
  async afterWrite(result: WriteResult): Promise<string[]> {
    if (this.mode === "off") return [];
    const paths = touchedPaths(result);
    const tracked = await this.notIgnored(paths);
    if (tracked.length === 0) return [];

    const add = await this.run(this.root, ["add", "-A", "--", ...tracked]);
    if (add.exitCode !== 0) return [`The change was not committed: ${firstLine(add.stderr)}`];
    const message = `backroom: ${result.summary}\n\n${OPERATION_TRAILER}: ${result.operation}\n`;
    const commit = await this.commit(["commit", "--quiet", "-m", message, "--", ...tracked]);
    if (commit.exitCode !== 0) return [`The change was not committed: ${firstLine(commit.stderr || commit.stdout)}`];
    return this.mode === "sync" ? this.push() : [];
  }

  async status(): Promise<string> {
    const status = await this.check(["status", "--short", "--branch"]);
    const lines = [status.trimEnd()];
    lines.push(`sync: ${this.mode}${this.blocked ? ` (stopped: ${this.blocked})` : ""}`);
    return lines.join("\n");
  }

  async log(options: { limit: number; path?: string }): Promise<string> {
    const args = ["log", `--max-count=${options.limit}`, "--date=iso-strict", "--format=%h%x09%ad%x09%an%x09%s"];
    if (options.path !== undefined) args.push("--", options.path);
    return (await this.check(args)).trimEnd();
  }

  async show(commit: string): Promise<string> {
    return (await this.check(["show", "--stat", "--patch", "--format=fuller", validCommit(commit)])).trimEnd();
  }

  /** Whether a commit was made by backroom, and the files it changed with their state before and after. */
  async commitChanges(commit: string): Promise<CommitChange[]> {
    const sha = validCommit(commit);
    const body = await this.check(["show", "--no-patch", "--format=%B", sha]);
    if (!new RegExp(`^${OPERATION_TRAILER}: `, "m").test(body)) {
      throw new BackroomError(
        "invalid_argument",
        `Commit ${commit} was not made by backroom, so it cannot be reverted.`,
      );
    }
    const parents = (await this.check(["show", "--no-patch", "--format=%P", sha])).trim().split(/\s+/);
    if (parents.length !== 1 || parents[0] === "") {
      throw new BackroomError("unsupported", `Commit ${commit} is not a regular commit with one parent.`);
    }
    const diff = await this.check(["diff", "--name-status", "--no-renames", "-z", `${sha}^`, sha]);
    const fields = diff.split("\0").filter((field) => field !== "");
    const changes: CommitChange[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const status = fields[i]!;
      const path = fields[i + 1]!;
      changes.push({
        path,
        before: status === "A" ? null : await this.fileAt(`${sha}^`, path),
        after: status === "D" ? null : await this.fileAt(sha, path),
      });
    }
    return changes;
  }

  /** When the file was first committed, following renames, or null when git has no history of it. */
  async firstCommitted(path: string): Promise<Date | null> {
    const log = await this.run(this.root, ["log", "--follow", "--diff-filter=A", "--format=%aI", "--", path]);
    const dates = log.stdout.split("\n").filter((line) => line !== "");
    return log.exitCode === 0 && dates.length > 0 ? new Date(dates.at(-1)!) : null;
  }

  private async fileAt(commit: string, path: string): Promise<string> {
    return this.check(["show", `${commit}:${path}`]);
  }

  private async push(): Promise<string[]> {
    if (this.blocked) return [`Not pushed, sync is stopped: ${this.blocked}`];
    let push = await this.run(this.root, ["push", "--quiet"]);
    if (push.exitCode === 0) return [];
    const failure = await this.pullRebase();
    if (failure) {
      this.blocked = failure;
      return [`Not pushed, sync is stopped until a human resolves it: ${failure}`];
    }
    push = await this.run(this.root, ["push", "--quiet"]);
    return push.exitCode === 0 ? [] : [`Not pushed: ${firstLine(push.stderr)}`];
  }

  private async commit(args: string[]): Promise<GitResult> {
    const identity = await this.run(this.root, ["config", "user.email"]);
    return this.run(this.root, identity.exitCode === 0 ? args : [...FALLBACK_IDENTITY, ...args]);
  }

  private async notIgnored(paths: string[]): Promise<string[]> {
    const ignored = await this.run(this.root, ["check-ignore", "--", ...paths]);
    const ignoredPaths = new Set(ignored.stdout.split("\n").filter((line) => line !== ""));
    return paths.filter((path) => !ignoredPaths.has(path));
  }

  private async check(args: string[]): Promise<string> {
    const result = await this.run(this.root, args);
    if (result.exitCode !== 0) {
      throw new BackroomError("invalid_argument", `git ${args[0]} failed: ${firstLine(result.stderr)}`);
    }
    return result.stdout;
  }
}

export type CommitChange = { path: string; before: string | null; after: string | null };

function touchedPaths(result: WriteResult): string[] {
  const paths = result.changes.flatMap((change) => {
    switch (change.kind) {
      case "create":
      case "modify":
        return [change.path];
      case "move":
        return [change.from, change.to];
      case "trash":
        return [change.path, ...(change.trashPath ? [change.trashPath] : [])];
    }
  });
  return [...new Set(paths)];
}

function validCommit(commit: string): string {
  if (!/^[0-9a-f]{4,40}$/i.test(commit)) throw new BackroomError("invalid_argument", `"${commit}" is not a commit id.`);
  return commit;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}
