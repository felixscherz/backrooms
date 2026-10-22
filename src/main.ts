#!/usr/bin/env bun
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
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

/** The settings of `backroom serve` (ADR 8), or what is wrong with them. */
export type ServerConfig = {
  url: string;
  passphraseHash: string;
  clientOrigins: string[];
  hostname: string;
  port: number;
};

export function serverConfig(env: Record<string, string | undefined>): ServerConfig | string {
  const url = env.BACKROOM_URL;
  if (!url) return "Set BACKROOM_URL to backroom's public URL, such as https://backroom.example.com.";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `BACKROOM_URL "${url}" is not a URL.`;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    return "BACKROOM_URL must use https, since the passphrase is entered there. Only localhost may use http.";
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    return "BACKROOM_URL must be an origin without a path, such as https://backroom.example.com.";
  }
  const passphraseHash = env.BACKROOM_PASSPHRASE_HASH;
  if (!passphraseHash?.startsWith("$argon2id$")) {
    return "Set BACKROOM_PASSPHRASE_HASH to the output of `backroom auth:hash`.";
  }
  const clientOrigins = (env.BACKROOM_CLIENT_ORIGINS ?? "https://claude.ai").split(",").map((origin) => origin.trim());
  for (const origin of clientOrigins) {
    if (!/^https:\/\/[^/]+$/.test(origin))
      return `BACKROOM_CLIENT_ORIGINS has "${origin}", which is not an https origin.`;
  }
  const listen = env.BACKROOM_LISTEN ?? "127.0.0.1:8484";
  const match = /^(.+):(\d+)$/.exec(listen);
  if (!match) return `BACKROOM_LISTEN must be host:port, not "${listen}".`;
  return { url: parsed.origin, passphraseHash, clientOrigins, hostname: match[1]!, port: Number(match[2]) };
}

/** The folder for backroom's own state, such as OAuth sign-ins: BACKROOM_STATE, else the XDG state folder. */
function stateFolder(): string {
  const folder = env("BACKROOM_STATE") ?? join(env("XDG_STATE_HOME") ?? join(homedir(), ".local", "state"), "backroom");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  return folder;
}

function pullInterval(): number | string {
  const interval = env("BACKROOM_PULL_INTERVAL") ?? "60";
  const seconds = Number(interval);
  return seconds > 0
    ? seconds * 1000
    : `BACKROOM_PULL_INTERVAL must be a positive number of seconds, not "${interval}".`;
}

const MIN_PASSPHRASE_LENGTH = 16;

function isGitMode(mode: string): mode is GitMode {
  return mode === "off" || mode === "commit" || mode === "sync";
}

async function main(argv: string[]): Promise<number> {
  const invocation = parseArguments(argv);
  if (invocation.command === "help" || invocation.command === "--help") {
    console.log(helpText());
    return 0;
  }
  if (invocation.command === "auth:hash") {
    const passphrase = (await new Response(Bun.stdin.stream()).text()).replace(/\r?\n$/, "");
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      console.log(`Error: The passphrase needs at least ${MIN_PASSPHRASE_LENGTH} characters. Pass it on stdin.`);
      return 1;
    }
    const { hashPassphrase } = await import("./oauth");
    console.log(await hashPassphrase(passphrase));
    return 0;
  }
  if (invocation.command === "auth:revoke") {
    const { OAuthStore } = await import("./oauth-store");
    const store = new OAuthStore(join(stateFolder(), "oauth.sqlite"));
    const removed = store.revokeAll();
    store.close();
    console.log(`Revoked every sign-in (${removed} codes and tokens).`);
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
  if (invocation.command === "mcp" || invocation.command === "serve") {
    const interval = pullInterval();
    if (typeof interval === "string") {
      console.log(`Error: ${interval}`);
      return 1;
    }
    if (invocation.command === "mcp") {
      const { serveStdio } = await import("./mcp");
      await serveStdio(engine, interval);
      return 0;
    }
    const config = serverConfig(process.env);
    if (typeof config === "string") {
      console.log(`Error: ${config}`);
      return 1;
    }
    const [{ serveHttp }, { AuthorizationServer }, { OAuthStore }, { systemClock }] = await Promise.all([
      import("./http"),
      import("./oauth"),
      import("./oauth-store"),
      import("./clock"),
    ]);
    const auth = new AuthorizationServer({
      issuer: config.url,
      passphraseHash: config.passphraseHash,
      clientOrigins: config.clientOrigins,
      store: new OAuthStore(join(stateFolder(), "oauth.sqlite")),
      clock: systemClock,
    });
    const server = serveHttp(engine, auth, { hostname: config.hostname, port: config.port, pullIntervalMs: interval });
    console.log(`backroom serves ${root} at ${config.url}/mcp, listening on ${server.url}`);
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
    await server.stop();
    return 0;
  }
  const result = await runCli(engine, invocation);
  if (result.output !== "") process.stdout.write(result.output.endsWith("\n") ? result.output : `${result.output}\n`);
  return result.exitCode;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
