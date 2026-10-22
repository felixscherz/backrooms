import { systemClock, type Clock } from "./clock";
import { BackroomsError } from "./errors";
import type { WriteResult } from "./engine";

/**
 * How backrooms uses git (ADR 6). `off` leaves git alone, `commit` records every write as one commit, `sync` also
 * pulls before each write and pushes after each commit.
 */
export type GitMode = "off" | "commit" | "sync";

export type GitResult = { exitCode: number; stdout: string; stderr: string };

/** Runs the git executable. A seam so tests and callers can see exactly what backrooms asks git to do. */
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

/** The trailer that marks a commit as made by backrooms, so revert only touches backrooms' own commits. */
export const OPERATION_TRAILER = "Backrooms-Operation";
/** The trailer from before the rename to backrooms, so commits made then can still be reverted. */
const LEGACY_OPERATION_TRAILER = "Backroom-Operation";

const FALLBACK_IDENTITY = ["-c", "user.name=backrooms", "-c", "user.email=backrooms@localhost"];

/** A commit as the history shows it. `id` is the abbreviated hash. */
export type Commit = { id: string; time: Date; author: string; message: string };

export type CommitDetails = Commit & {
  files: { path: string; status: "added" | "modified" | "deleted" | "renamed" | "other" }[];
  patch: string;
};

/** Where syncing stands: when it last pulled and pushed, and what is not committed or pushed yet. */
export type SyncState = {
  mode: GitMode;
  /** Why sync stopped, until a human resolves it. */
  stopped: string | null;
  lastPull: Date | null;
  lastPush: Date | null;
  /** Files that differ from the last commit. */
  uncommitted: string[];
  /** Commits the remote does not have yet, or null without an upstream branch. */
  unpushed: number | null;
};

export class Git {
  /** Set when a sync failed in a way a human has to resolve. Writes keep working locally in the meantime. */
  private blocked: string | null = null;
  private lastPull: Date | null = null;
  private lastPush: Date | null = null;

  constructor(
    private readonly root: string,
    readonly mode: GitMode,
    private readonly run: GitRunner = runGit,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Brings in changes from the remote before a write, so the write is planned against the latest vault. */
  async beforeWrite(): Promise<void> {
    if (this.mode !== "sync" || this.blocked) return;
    const failure = await this.pullRebase();
    if (failure) this.blocked = failure;
    else this.lastPull = this.clock.now();
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
    const message = `backrooms: ${result.summary}\n\n${OPERATION_TRAILER}: ${result.operation}\n`;
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

  async syncState(): Promise<SyncState> {
    const status = await this.check(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const uncommitted: string[] = [];
    const fields = status.split("\0").filter((field) => field !== "");
    for (let i = 0; i < fields.length; i++) {
      uncommitted.push(fields[i]!.slice(3));
      // A rename lists its original path in the next field.
      if (/^[RC]/.test(fields[i]!)) i++;
    }
    const ahead = await this.run(this.root, ["rev-list", "--count", "@{upstream}..HEAD"]);
    return {
      mode: this.mode,
      stopped: this.blocked,
      lastPull: this.lastPull,
      lastPush: this.lastPush,
      uncommitted,
      unpushed: ahead.exitCode === 0 ? Number(ahead.stdout.trim()) : null,
    };
  }

  /** The latest commits, newest first, optionally only those that changed one file, following renames. */
  async commits(options: { limit: number; path?: string }): Promise<Commit[]> {
    const args = ["log", `--max-count=${options.limit}`, "--format=%h%x1f%aI%x1f%an%x1f%s%x1e"];
    if (options.path !== undefined) args.push("--follow", "--", options.path);
    const log = await this.run(this.root, args);
    // A repository without commits has no history yet.
    if (log.exitCode !== 0 && /does not have any commits/.test(log.stderr)) return [];
    if (log.exitCode !== 0) throw new BackroomsError("invalid_argument", `git log failed: ${firstLine(log.stderr)}`);
    return log.stdout
      .split("\x1e")
      .map((record) => record.trim())
      .filter((record) => record !== "")
      .map((record) => {
        const [id, time, author, message] = record.split("\x1f") as [string, string, string, string];
        return { id, time: new Date(time), author, message };
      });
  }

  async commitDetails(commit: string): Promise<CommitDetails> {
    const sha = validCommit(commit);
    const header = await this.check(["show", "--no-patch", "--format=%h%x1f%aI%x1f%an%x1f%B", sha]);
    const [id, time, author, message] = header.split("\x1f") as [string, string, string, string];
    const names = await this.check(["show", "--format=", "--name-status", "-z", sha]);
    const fields = names.split("\0").filter((field) => field !== "");
    const files: CommitDetails["files"] = [];
    for (let i = 0; i < fields.length; i++) {
      const code = fields[i]![0];
      const status =
        code === "A"
          ? "added"
          : code === "M"
            ? "modified"
            : code === "D"
              ? "deleted"
              : code === "R"
                ? "renamed"
                : "other";
      // A rename or copy lists the old and the new path, and the file is where it is now.
      if (code === "R" || code === "C") i++;
      files.push({ path: fields[++i]!, status });
    }
    const patch = await this.check(["show", "--format=", "--patch", sha]);
    return { id, time: new Date(time), author, message: message.trim(), files, patch: patch.trimEnd() };
  }

  async log(options: { limit: number; path?: string }): Promise<string> {
    const args = ["log", `--max-count=${options.limit}`, "--date=iso-strict", "--format=%h%x09%ad%x09%an%x09%s"];
    if (options.path !== undefined) args.push("--", options.path);
    return (await this.check(args)).trimEnd();
  }

  async show(commit: string): Promise<string> {
    return (await this.check(["show", "--stat", "--patch", "--format=fuller", validCommit(commit)])).trimEnd();
  }

  /** Whether a commit was made by backrooms, and the files it changed with their state before and after. */
  async commitChanges(commit: string): Promise<CommitChange[]> {
    const sha = validCommit(commit);
    const body = await this.check(["show", "--no-patch", "--format=%B", sha]);
    if (!new RegExp(`^(${OPERATION_TRAILER}|${LEGACY_OPERATION_TRAILER}): `, "m").test(body)) {
      throw new BackroomsError(
        "invalid_argument",
        `Commit ${commit} was not made by backrooms, so it cannot be reverted.`,
      );
    }
    const parents = (await this.check(["show", "--no-patch", "--format=%P", sha])).trim().split(/\s+/);
    if (parents.length !== 1 || parents[0] === "") {
      throw new BackroomsError("unsupported", `Commit ${commit} is not a regular commit with one parent.`);
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
    if (push.exitCode === 0) {
      this.lastPush = this.clock.now();
      return [];
    }
    const failure = await this.pullRebase();
    if (failure) {
      this.blocked = failure;
      return [`Not pushed, sync is stopped until a human resolves it: ${failure}`];
    }
    this.lastPull = this.clock.now();
    push = await this.run(this.root, ["push", "--quiet"]);
    if (push.exitCode !== 0) return [`Not pushed: ${firstLine(push.stderr)}`];
    this.lastPush = this.clock.now();
    return [];
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
      throw new BackroomsError("invalid_argument", `git ${args[0]} failed: ${firstLine(result.stderr)}`);
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
  if (!/^[0-9a-f]{4,40}$/i.test(commit))
    throw new BackroomsError("invalid_argument", `"${commit}" is not a commit id.`);
  return commit;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}
