/**
 * Records what the Obsidian CLI answers to every command in `commands.txt`, and what every write in `writes.txt`
 * does to the vault. Needs the Obsidian app running with test-vault open as a vault, and writes everything to
 * `obsidian.json`, which the compatibility test replays against backrooms. After each write, the notes of test-vault
 * are reset to their committed state with git, so uncommitted changes to them are lost.
 */
import { writeFileSync } from "node:fs";
import { changesBetween, loadCommands, RECORDING, snapshot, VAULT, type Recording } from "./commands";
import { git as gitIn, obsidian as obsidianIn } from "./obsidian";

const obsidian = (args: string[]) => obsidianIn(VAULT, args);
const git = (...args: string[]) => gitIn(VAULT, ...args);

/**
 * Puts the notes of test-vault back to their committed state and gives Obsidian time to notice. `types.json` is
 * reset too, since `property:set ... type=` records the type there.
 */
async function resetVault() {
  await git("checkout", "--", ".", ":(exclude).obsidian", ".obsidian/types.json");
  await git("clean", "-fdq", "--", ".", ":(exclude).obsidian");
  await Bun.sleep(1500);
}

// Reloading makes Obsidian read its settings and index the vault afresh.
await obsidian(["command", "id=app:reload"]);
await Bun.sleep(6000);
const version = (await obsidian(["version"])).trim();
const recording: Recording = { obsidian: version, outputs: {}, writes: {} };
for (const command of loadCommands()) {
  recording.outputs[command.line] = await obsidian(command.args);
}

const writes = loadCommands("writes.txt");
if (writes.length > 0) await resetVault();
for (const command of writes) {
  const before = await snapshot(VAULT);
  const output = await obsidian(command.args);
  await Bun.sleep(1000);
  recording.writes[command.line] = { output, changes: changesBetween(before, await snapshot(VAULT)) };
  await resetVault();
}

writeFileSync(RECORDING, `${JSON.stringify(recording, null, 2)}\n`);
console.log(
  `Recorded ${Object.keys(recording.outputs).length} commands and ${writes.length} writes from Obsidian ${version}.`,
);
