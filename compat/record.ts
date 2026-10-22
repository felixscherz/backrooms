/**
 * Records what the Obsidian CLI answers to every command in `commands.txt`. Needs the Obsidian app running with
 * test-vault open as a vault, and writes the answers to `obsidian.json`, which the compatibility test replays
 * against backroom.
 */
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { loadCommands, RECORDING, VAULT, type Recording } from "./commands";

/** Runs the Obsidian CLI. It sometimes hangs without answering, so a call that takes too long is retried. */
async function obsidian(args: string[], attempts = 3): Promise<string> {
  const process = Bun.spawn(["obsidian", `vault=${basename(VAULT)}`, ...args], {
    cwd: VAULT,
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
  if (attempts > 1) return obsidian(args, attempts - 1);
  throw new Error(`obsidian ${args.join(" ")} timed out. Is a dialog open in Obsidian?`);
}

const version = (await obsidian(["version"])).trim();
const recording: Recording = { obsidian: version, outputs: {} };
for (const command of loadCommands()) {
  recording.outputs[command.line] = await obsidian(command.args);
}
writeFileSync(RECORDING, `${JSON.stringify(recording, null, 2)}\n`);
console.log(`Recorded ${Object.keys(recording.outputs).length} commands from Obsidian ${version}.`);
