import { describe, expect, test } from "bun:test";
import { parseArguments, runCli } from "../src/cli";
import { Engine } from "../src/engine";
import { loadCommands, loadRecording, VAULT, withoutOrder } from "./commands";

const recording = loadRecording();
const engine = new Engine(VAULT);

/** What the backroom executable prints for a command: the output and a final newline, like the Obsidian CLI. */
async function backroom(args: string[]): Promise<string> {
  const { output } = await runCli(engine, parseArguments(args));
  return output.endsWith("\n") ? output : `${output}\n`;
}

describe(`answers like Obsidian ${recording.obsidian} on test-vault`, () => {
  for (const command of loadCommands()) {
    test(command.line, async () => {
      const expected = recording.outputs[command.line];
      if (expected === undefined) throw new Error("Not recorded yet. Run `bun compat/record.ts`.");
      const actual = await backroom(command.args);
      if (command.unordered) expect(withoutOrder(actual)).toBe(withoutOrder(expected));
      else expect(actual).toBe(expected);
    });
  }
});
