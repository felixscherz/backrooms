import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../git";

/** Runs git with a test identity and returns its output, failing when git does. */
export async function git(root: string, ...args: string[]): Promise<string> {
  const result = await runGit(root, ["-c", "user.name=test", "-c", "user.email=test@localhost", ...args]);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A bare remote for the vault repository, and a clone of it standing in for another device that syncs the vault. */
export type GitRemote = {
  /** The other device's clone. */
  other: string;
  /** Commits a file on the other device and pushes it. */
  pushFromOther(path: string, text: string): Promise<void>;
  remove(): Promise<void>;
};

export async function gitRemote(vaultRoot: string): Promise<GitRemote> {
  const remote = await mkdtemp(join(tmpdir(), "backrooms-remote-"));
  const other = await mkdtemp(join(tmpdir(), "backrooms-other-"));
  await git(remote, "init", "--quiet", "--bare");
  await git(vaultRoot, "remote", "add", "origin", remote);
  await git(vaultRoot, "push", "--quiet", "-u", "origin", "HEAD");
  await git(other, "clone", "--quiet", remote, ".");
  return {
    other,
    pushFromOther: async (path, text) => {
      await Bun.write(join(other, path), text);
      await git(other, "add", "-A");
      await git(other, "commit", "--quiet", "-m", "vault backup");
      await git(other, "push", "--quiet");
    },
    remove: async () => {
      await rm(remote, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    },
  };
}
