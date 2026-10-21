#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { helpText, parseArguments, runCli } from "./cli";
import { Engine } from "./engine";

/** The vault is BACKROOM_VAULT, or the nearest folder at or above `cwd` that holds a `.obsidian` folder. */
export function findVault(env: Record<string, string | undefined>, cwd: string): string | null {
  const configured = env.BACKROOM_VAULT;
  if (configured) return resolve(cwd, configured);
  for (let folder = resolve(cwd); ; folder = dirname(folder)) {
    const settings = join(folder, ".obsidian");
    if (existsSync(settings) && statSync(settings).isDirectory()) return folder;
    if (dirname(folder) === folder) return null;
  }
}

async function main(argv: string[]): Promise<number> {
  const invocation = parseArguments(argv);
  if (invocation.command === "help" || invocation.command === "--help") {
    console.log(helpText());
    return 0;
  }
  const root = findVault(process.env, process.cwd());
  if (!root || !existsSync(root)) {
    console.log("Error: No vault found. Set BACKROOM_VAULT or run backroom inside a vault with a .obsidian folder.");
    return 1;
  }
  const engine = new Engine(root);
  if (invocation.command === "mcp") {
    const { serveStdio } = await import("./mcp");
    await serveStdio(engine);
    return 0;
  }
  const result = await runCli(engine, invocation);
  if (result.output !== "") process.stdout.write(result.output.endsWith("\n") ? result.output : `${result.output}\n`);
  return result.exitCode;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
