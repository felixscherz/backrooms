import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { parseArguments, runCli, type CliResult } from "../cli";
import { Engine } from "../engine";
import { Git, runGit, type GitMode } from "../git";

/** A vault in a temporary folder, driven through the CLI the way a user would drive it. */
export type TempVault = {
  root: string;
  engine: Engine;
  /** Runs a CLI command, given as the arguments a shell would pass. */
  run(...argv: string[]): Promise<CliResult>;
  /** Runs a CLI command and returns its output, failing the test when it reports an error. */
  ok(...argv: string[]): Promise<string>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  /** All files below the root, including hidden ones, with their content. */
  snapshot(): Promise<Record<string, string>>;
  remove(): Promise<void>;
};

export type TempVaultOptions = {
  /** Makes the vault a git repository with one commit of the files, and gives the engine this git mode. */
  git?: GitMode;
};

export async function tempVault(
  files: Record<string, string>,
  settings: Record<string, unknown> = {},
  options: TempVaultOptions = {},
): Promise<TempVault> {
  const root = await mkdtemp(join(tmpdir(), "backroom-test-"));
  await mkdir(join(root, ".obsidian"));
  await writeFile(join(root, ".obsidian", "app.json"), JSON.stringify(settings));
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  for (const [path, text] of Object.entries(files)) await write(path, text);

  let git: Git | undefined;
  if (options.git) {
    for (const args of [
      ["init", "--quiet"],
      ["add", "-A"],
      ["commit", "--quiet", "-m", "initial"],
    ]) {
      await runGit(root, ["-c", "user.name=test", "-c", "user.email=test@localhost", ...args]);
    }
    git = new Git(root, options.git);
  }
  const engine = new Engine(root, { git });
  const run = (...argv: string[]) => runCli(engine, parseArguments(argv));
  return {
    root,
    engine,
    run,
    ok: async (...argv) => {
      const result = await run(...argv);
      if (result.exitCode !== 0) throw new Error(`backroom ${argv.join(" ")} failed: ${result.output}`);
      return result.output;
    },
    read: (path) => readFile(join(root, path), "utf8"),
    write,
    snapshot: async () => {
      const result: Record<string, string> = {};
      const walk = async (folder: string) => {
        for (const dirent of await readdir(folder, { withFileTypes: true })) {
          const path = join(folder, dirent.name);
          if (dirent.isDirectory()) await walk(path);
          else result[relative(root, path)] = await readFile(path, "utf8");
        }
      };
      await walk(root);
      return result;
    },
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
