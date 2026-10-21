#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { helpText, parseArguments, runCli } from "./cli";
import { Engine } from "./engine";
import { Git, type GitMode } from "./git";

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

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function isGitMode(mode: string): mode is GitMode {
  return mode === "off" || mode === "commit" || mode === "sync";
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
  const mode = env("BACKROOM_GIT") ?? "off";
  if (!isGitMode(mode)) {
    console.log(`Error: BACKROOM_GIT must be off, commit or sync, not "${mode}".`);
    return 1;
  }
  const isRepository = existsSync(join(root, ".git"));
  if (mode !== "off" && !isRepository) {
    console.log(`Error: BACKROOM_GIT is ${mode}, but the vault at ${root} is not a git repository.`);
    return 1;
  }
  const engine = new Engine(root, isRepository ? { git: new Git(root, mode) } : {});
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
