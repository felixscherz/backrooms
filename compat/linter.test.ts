import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArguments, runCli } from "../src/cli";
import { Engine } from "../src/engine";
import {
  changesBetween,
  LINTER_RECORDING,
  LINTER_VAULT,
  loadCommands,
  parsedChanges,
  snapshot,
  withRecentTimestamps,
  type LinterRecording,
} from "./commands";

const recording: LinterRecording = JSON.parse(readFileSync(LINTER_RECORDING, "utf8"));

describe(`lints like the Linter ${recording.linter} in Obsidian ${recording.obsidian} on a copy of linter-vault`, () => {
  const copies: string[] = [];
  afterEach(async () => {
    for (const copy of copies.splice(0)) await rm(copy, { recursive: true, force: true });
  });

  for (const command of loadCommands("linter.txt")) {
    test(command.line, async () => {
      const expected = recording.writes[command.line];
      if (expected === undefined) throw new Error("Not recorded yet. Run `bun compat/record-linter.ts`.");
      const copy = await mkdtemp(join(tmpdir(), "backroom-linter-"));
      copies.push(copy);
      // A fresh copy dates its notes now, as the recorder does by checking them out again before each write.
      await cp(LINTER_VAULT, copy, { recursive: true });
      const before = await snapshot(copy);
      const { output } = await runCli(new Engine(copy), parseArguments(command.args));
      const changes = withRecentTimestamps(changesBetween(before, await snapshot(copy)), new Date());
      const printed = output.endsWith("\n") ? output : `${output}\n`;
      if (command.unordered) {
        const [actual, recorded] = parsedChanges(before, changes, expected.changes);
        expect({ output: printed, changes: actual }).toEqual({ output: expected.output, changes: recorded });
      } else {
        expect({ output: printed, changes }).toEqual(expected);
      }
    });
  }
});
