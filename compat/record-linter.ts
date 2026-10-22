/**
 * Records what every write in `linter.txt` does to linter-vault in Obsidian once the Linter lints the note it
 * saved, and writes it to `linter.json`, which the Linter compatibility test replays against backroom. Needs the
 * Obsidian app running with compat/linter-vault open as a vault; the Linter is installed there if it is missing.
 * Before each write, the notes of linter-vault are created afresh from git, so their creation date is the time of
 * the run, and uncommitted changes to them are lost.
 */
import { writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  changesBetween,
  LINTER_RECORDING,
  LINTER_VAULT,
  loadCommands,
  snapshot,
  withRecentTimestamps,
  type LinterRecording,
} from "./commands";
import { git, obsidian as obsidianIn } from "./obsidian";

const obsidian = (args: string[]) => obsidianIn(LINTER_VAULT, args);

/** Deletes the notes and checks them out again, so the file system dates them now, and gives Obsidian time. */
async function recreateNotes() {
  for (const entry of await readdir(LINTER_VAULT)) {
    if (entry !== ".obsidian") await rm(join(LINTER_VAULT, entry), { recursive: true, force: true });
  }
  await git(LINTER_VAULT, "checkout", "--", ".", ":(exclude).obsidian");
  await Bun.sleep(1500);
}

if (!(await obsidian(["plugins", "filter=community"])).includes("obsidian-linter")) {
  await obsidian(["plugins:restrict", "off"]);
  console.log((await obsidian(["plugin:install", "id=obsidian-linter", "enable"])).trim());
}
await obsidian(["command", "id=app:reload"]);
await Bun.sleep(6000);
const linter = (await obsidian(["plugins", "filter=community", "versions"])).trim().split("\t")[1] ?? "unknown";
const recording: LinterRecording = {
  obsidian: (await obsidian(["version"])).trim(),
  linter,
  writes: {},
};

for (const command of loadCommands("linter.txt")) {
  await recreateNotes();
  const before = await snapshot(LINTER_VAULT);
  const output = await obsidian(command.args);
  const path = command.args.find((arg) => arg.startsWith("path="))!.slice("path=".length);
  await Bun.sleep(1000);
  await obsidian(["open", `path=${path}`]);
  await Bun.sleep(1500);
  await obsidian(["command", "id=obsidian-linter:lint-file-unless-ignored"]);
  // The Linter changes the open editor, which Obsidian writes to disk later. Saving writes it now.
  await Bun.sleep(500);
  await obsidian(["command", "id=editor:save-file"]);
  await Bun.sleep(1500);
  const changes = changesBetween(before, await snapshot(LINTER_VAULT));
  recording.writes[command.line] = { output, changes: withRecentTimestamps(changes, new Date()) };
}
await recreateNotes();
await obsidian(["command", "id=workspace:close-others"]);

writeFileSync(LINTER_RECORDING, `${JSON.stringify(recording, null, 2)}\n`);
console.log(
  `Recorded ${Object.keys(recording.writes).length} writes from the Linter ${linter} in Obsidian ${recording.obsidian}.`,
);
