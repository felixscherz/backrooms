import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverConfig } from "./main";
import { OAuthStore } from "./oauth-store";
import { gitRemote } from "./testing/git-remote";
import { tempVault, type TempVault } from "./testing/temp-vault";

const MAIN = join(import.meta.dir, "main.ts");

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

/** `backrooms mcp` running as its own process, spoken to over stdio the way an MCP client does. */
async function mcpServer(vault: TempVault, env: Record<string, string> = {}) {
  const server = Bun.spawn([process.execPath, MAIN, "mcp"], {
    env: { ...process.env, BACKROOMS_VAULT: vault.root, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanup.push(async () => {
    server.kill();
    await server.exited;
  });

  const responses = new Map<number, (message: Record<string, unknown>) => void>();
  void (async () => {
    let buffer = "";
    for await (const chunk of server.stdout.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        responses.get(message.id)?.(message);
      }
    }
  })();

  let nextId = 1;
  const send = (message: Record<string, unknown>) => {
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    server.stdin.flush();
  };
  const request = (method: string, params: Record<string, unknown>) => {
    const id = nextId++;
    const response = new Promise<Record<string, unknown>>((resolve) => responses.set(id, resolve));
    send({ id, method, params });
    return response;
  };

  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  send({ method: "notifications/initialized" });

  return {
    process: server,
    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
      const response = await request("tools/call", { name, arguments: args });
      const result = response.result as { content: { text: string }[]; isError?: boolean };
      const text = result.content.map((part) => part.text).join("");
      if (result.isError) throw new Error(`${name} failed: ${text}`);
      return text;
    },
    async toolNames(): Promise<string[]> {
      const response = await request("tools/list", {});
      return (response.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    },
  };
}

async function vaultWith(files: Record<string, string>, git?: "sync"): Promise<TempVault> {
  const vault = await tempVault(files, {}, git ? { git } : {});
  cleanup.push(() => vault.remove());
  return vault;
}

/** Waits until the check passes, failing after a few seconds. */
async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (const deadline = Date.now() + 5000; Date.now() < deadline; await Bun.sleep(50)) {
    if (await check()) return;
  }
  throw new Error("The condition was not met within 5 seconds.");
}

describe("backrooms mcp", () => {
  test("serves the vault's tools over stdio", async () => {
    const vault = await vaultWith({ "Pizza.md": "# Pizza\n" });
    const server = await mcpServer(vault);

    expect(await server.toolNames()).toContain("search");
    expect(JSON.parse(await server.callTool("read", { notes: "Pizza" })).notes[0].content).toBe("# Pizza\n");
    await server.callTool("edit", { note: "Pizza", changes: [{ op: "append", content: "Dough" }] });
    expect(await vault.read("Pizza.md")).toBe("# Pizza\nDough");
  });

  test("exits when the client closes stdin", async () => {
    const vault = await vaultWith({});
    const server = await mcpServer(vault);

    await server.process.stdin.end();

    const exit = await Promise.race([server.process.exited, Bun.sleep(5000).then(() => "still running")]);
    expect(exit).toBe(0);
  });

  test("in sync mode, pulls what another device pushed without waiting for a write", async () => {
    const vault = await vaultWith({ "A.md": "a" }, "sync");
    const remote = await gitRemote(vault.root);
    cleanup.push(() => remote.remove());
    await mcpServer(vault, { BACKROOMS_GIT: "sync", BACKROOMS_PULL_INTERVAL: "0.1" });

    await remote.pushFromOther("Phone.md", "from the phone");

    await eventually(async () => await Bun.file(join(vault.root, "Phone.md")).exists());
    expect(await vault.read("Phone.md")).toBe("from the phone");
  });

  test("in sync mode, exits when the client closes stdin, although the pull timer is running", async () => {
    const vault = await vaultWith({ "A.md": "a" }, "sync");
    const remote = await gitRemote(vault.root);
    cleanup.push(() => remote.remove());
    const server = await mcpServer(vault, { BACKROOMS_GIT: "sync", BACKROOMS_PULL_INTERVAL: "0.1" });

    await server.process.stdin.end();

    const exit = await Promise.race([server.process.exited, Bun.sleep(5000).then(() => "still running")]);
    expect(exit).toBe(0);
  });
});

describe("configuration", () => {
  test("a pull interval that is not a positive number of seconds is refused", async () => {
    const vault = await vaultWith({});
    const run = Bun.spawn([process.execPath, MAIN, "mcp"], {
      env: { ...process.env, BACKROOMS_VAULT: vault.root, BACKROOMS_PULL_INTERVAL: "soon" },
      stdin: "ignore",
      stdout: "pipe",
    });

    expect(await run.exited).toBe(1);
    expect(await new Response(run.stdout).text()).toBe(
      'Error: BACKROOMS_PULL_INTERVAL must be a positive number of seconds, not "soon".\n',
    );
  });
});

describe("backrooms serve", () => {
  async function waitForServer(url: string): Promise<Response> {
    for (const deadline = Date.now() + 5000; Date.now() < deadline; await Bun.sleep(50)) {
      try {
        return await fetch(url);
      } catch {}
    }
    throw new Error(`${url} did not answer within 5 seconds.`);
  }

  test("serves the MCP endpoint behind OAuth and stops on SIGTERM", async () => {
    const vault = await vaultWith({ "A.md": "a" });
    const state = await mkdtemp(join(tmpdir(), "backrooms-state-"));
    cleanup.push(() => rm(state, { recursive: true, force: true }));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const hash = await Bun.password.hash("a long passphrase for tests", { algorithm: "argon2id" });
    const server = Bun.spawn([process.execPath, MAIN, "serve"], {
      env: {
        ...process.env,
        BACKROOMS_VAULT: vault.root,
        BACKROOMS_URL: `http://localhost:${port}`,
        BACKROOMS_LISTEN: `127.0.0.1:${port}`,
        BACKROOMS_PASSPHRASE_HASH: hash,
        BACKROOMS_STATE: state,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    cleanup.push(async () => {
      server.kill();
      await server.exited;
    });

    const response = await waitForServer(`http://127.0.0.1:${port}/mcp`);
    const metadata = await (await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`)).json();
    server.kill("SIGTERM");

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(`http://localhost:${port}/.well-known/`);
    expect(metadata).toMatchObject({ issuer: `http://localhost:${port}` });
    expect(await server.exited).toBe(0);
    expect(await Bun.file(join(state, "oauth.sqlite")).exists()).toBe(true);
  });

  test("refuses to start without its configuration, and says what is missing", () => {
    const hash = "$argon2id$v=19$m=65536,t=2,p=1$abc$def";

    expect(serverConfig({})).toContain("Set BACKROOMS_URL");
    expect(serverConfig({ BACKROOMS_URL: "http://backrooms.example.com", BACKROOMS_PASSPHRASE_HASH: hash })).toContain(
      "must use https",
    );
    expect(
      serverConfig({ BACKROOMS_URL: "https://backrooms.example.com/mcp", BACKROOMS_PASSPHRASE_HASH: hash }),
    ).toContain("without a path");
    expect(serverConfig({ BACKROOMS_URL: "https://backrooms.example.com" })).toContain("BACKROOMS_PASSPHRASE_HASH");
    expect(
      serverConfig({
        BACKROOMS_URL: "https://backrooms.example.com",
        BACKROOMS_PASSPHRASE_HASH: hash,
        BACKROOMS_CLIENT_ORIGINS: "https://claude.ai, http://opencode.local",
      }),
    ).toContain('"http://opencode.local"');
    expect(serverConfig({ BACKROOMS_URL: "https://backrooms.example.com/", BACKROOMS_PASSPHRASE_HASH: hash })).toEqual({
      url: "https://backrooms.example.com",
      passphraseHash: hash,
      clientOrigins: ["https://claude.ai"],
      hostname: "127.0.0.1",
      port: 8484,
    });
  });
});

describe("backrooms auth", () => {
  test("auth:hash prints an argon2id hash of the passphrase on stdin, and refuses a short one", async () => {
    const run = async (input: string) => {
      const process = Bun.spawn([globalThis.process.execPath, MAIN, "auth:hash"], {
        stdin: new Blob([input]),
        stdout: "pipe",
      });
      return { exitCode: await process.exited, output: (await new Response(process.stdout).text()).trim() };
    };

    const hashed = await run("a long passphrase for tests\n");
    const short = await run("short\n");

    expect(hashed.exitCode).toBe(0);
    expect(await Bun.password.verify("a long passphrase for tests", hashed.output)).toBe(true);
    expect(short).toEqual({
      exitCode: 1,
      output: "Error: The passphrase needs at least 16 characters. Pass it on stdin.",
    });
  });

  test("auth:revoke ends every sign-in in the state folder", async () => {
    const state = await mkdtemp(join(tmpdir(), "backrooms-state-"));
    cleanup.push(() => rm(state, { recursive: true, force: true }));
    const store = new OAuthStore(join(state, "oauth.sqlite"));
    const token = store.issue({ kind: "access", grant: "g", clientId: "c", resource: "r" }, Date.now() + 60_000);
    store.close();

    const process = Bun.spawn([globalThis.process.execPath, MAIN, "auth:revoke"], {
      env: { ...globalThis.process.env, BACKROOMS_STATE: state },
      stdout: "pipe",
    });

    expect(await process.exited).toBe(0);
    expect((await new Response(process.stdout).text()).trim()).toBe("Revoked every sign-in (1 codes and tokens).");
    expect(new OAuthStore(join(state, "oauth.sqlite")).find(token)).toBeNull();
  });
});
