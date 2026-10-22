import { basename } from "node:path";

/**
 * Runs the Obsidian CLI on the vault in the folder, which has to be open in Obsidian under the name of the folder.
 * The CLI sometimes hangs without answering, so a call that takes too long is retried.
 */
export async function obsidian(vault: string, args: string[], attempts = 3): Promise<string> {
  const process = Bun.spawn(["obsidian", `vault=${basename(vault)}`, ...args], {
    cwd: vault,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timeout = setTimeout(() => process.kill("SIGKILL"), 15_000);
  const [stdout, stderr] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  clearTimeout(timeout);
  await process.exited;
  if (process.signalCode === null) return stdout + stderr;
  if (attempts > 1) return obsidian(vault, args, attempts - 1);
  throw new Error(`obsidian ${args.join(" ")} timed out. Is a dialog open in Obsidian?`);
}

export async function git(vault: string, ...args: string[]) {
  const process = Bun.spawn(["git", ...args], { cwd: vault, stdout: "ignore", stderr: "inherit" });
  if ((await process.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
}
