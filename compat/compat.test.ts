import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArguments, runCli } from "../src/cli";
import { Engine } from "../src/engine";
import {
  changesBetween,
  loadCommands,
  loadRecording,
  snapshot,
  VAULT,
  withoutOrder,
  withParsedFrontmatter,
} from "./commands";

const recording = loadRecording();

/** What the backroom executable prints for a command: the output and a final newline, like the Obsidian CLI. */
async function backroom(engine: Engine, args: string[]): Promise<string> {
  const { output } = await runCli(engine, parseArguments(args));
  return output === "" || output.endsWith("\n") ? output : `${output}\n`;
}

describe(`answers like Obsidian ${recording.obsidian} on test-vault`, () => {
  const engine = new Engine(VAULT);
  for (const command of loadCommands()) {
    test(command.line, async () => {
      const expected = recording.outputs[command.line];
      if (expected === undefined) throw new Error("Not recorded yet. Run `bun compat/record.ts`.");
      const actual = await backroom(engine, command.args);
      if (command.unordered) expect(withoutOrder(actual)).toBe(withoutOrder(expected));
      else expect(actual).toBe(expected);
    });
  }
});

describe(`writes like Obsidian ${recording.obsidian} on a copy of test-vault`, () => {
  const copies: string[] = [];
  afterEach(async () => {
    for (const copy of copies.splice(0)) await rm(copy, { recursive: true, force: true });
  });

  for (const command of loadCommands("writes.txt")) {
    test(command.line, async () => {
      const expected = recording.writes[command.line];
      if (expected === undefined) throw new Error("Not recorded yet. Run `bun compat/record.ts`.");
      const copy = await mkdtemp(join(tmpdir(), "backroom-compat-"));
      copies.push(copy);
      await cp(VAULT, copy, { recursive: true });
      const before = await snapshot(copy);
      const output = await backroom(new Engine(copy), command.args);
      const changes = changesBetween(before, await snapshot(copy));
      if (command.unordered) {
        expect({ output, changes: withParsedFrontmatter(changes) }).toEqual({
          output: expected.output,
          changes: withParsedFrontmatter(expected.changes),
        });
      } else {
        expect({ output, changes }).toEqual(expected);
      }
    });
  }
});
