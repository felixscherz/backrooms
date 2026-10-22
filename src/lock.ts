import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackroomError } from "./errors";

/**
 * A lock that one writer at a time holds while it changes a vault, so writes from several backroom processes, such
 * as the MCP server and a CLI run, never interleave. Without it, a write could land between another write's version
 * check and its rename, and be overwritten without either caller noticing.
 *
 * The lock is a file outside the vault's notes, so Obsidian and git never see it, holding the id of the process
 * that holds it. A lock left behind by a process that ended is taken over.
 */
export class VaultLock {
  constructor(
    readonly path: string,
    private readonly timeoutMs: number = 10_000,
  ) {}

  /**
   * The lock of the vault at the root. In a git repository it lives in `.git`, which every process sees even when a
   * service has a private temporary folder. Otherwise it lives in the temporary folder, named after the real path of
   * the root so every path to the vault finds the same lock.
   */
  static of(root: string): VaultLock {
    const git = join(root, ".git");
    if (statSync(git, { throwIfNoEntry: false })?.isDirectory()) return new VaultLock(join(git, "backroom.lock"));
    const id = createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 16);
    return new VaultLock(join(tmpdir(), `backroom-${id}.lock`));
  }

  async hold<T>(step: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await step();
    } finally {
      await unlink(this.path).catch(() => {});
    }
  }

  private async acquire(): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    for (let wait = 1; ; wait = Math.min(wait * 2, 50)) {
      try {
        await writeFile(this.path, String(process.pid), { flag: "wx" });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (await this.takeOverAbandoned()) continue;
      if (Date.now() > deadline) {
        throw new BackroomError(
          "busy",
          `Another backroom process has been writing to the vault for over ${this.timeoutMs / 1000} seconds. Retry later, or remove ${this.path} if no backroom process is running.`,
        );
      }
      await Bun.sleep(wait);
    }
  }

  /** Removes the lock when the process holding it has ended. Returns whether it did. */
  private async takeOverAbandoned(): Promise<boolean> {
    let holder: string;
    let before;
    try {
      before = await stat(this.path);
      holder = await readFile(this.path, "utf8");
    } catch {
      return true;
    }
    // A lock just created may not have its process id written yet.
    if (holder === "" || isRunning(Number(holder))) return false;
    // Only remove the file that was read, not a lock another process took over in the meantime.
    const after = await stat(this.path).catch(() => null);
    if (after?.ino !== before.ino) return true;
    await unlink(this.path).catch(() => {});
    return true;
  }
}

function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
