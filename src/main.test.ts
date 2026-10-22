import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { gitRemote } from "./testing/git-remote";
import { tempVault, type TempVault } from "./testing/temp-vault";

const MAIN = join(import.meta.dir, "main.ts");

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

/** `backroom mcp` running as its own process, spoken to over stdio the way an MCP client does. */
async function mcpServer(vault: TempVault, env: Record<string, string> = {}) {
  const server = Bun.spawn([process.execPath, MAIN, "mcp"], {
    env: { ...process.env, BACKROOM_VAULT: vault.root, ...env },
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

describe("backroom mcp", () => {
  test("serves the vault's tools over stdio", async () => {
    const vault = await vaultWith({ "Pizza.md": "# Pizza\n" });
    const server = await mcpServer(vault);

    expect(await server.toolNames()).toContain("search_context");
    expect(await server.callTool("read", { path: "Pizza.md" })).toBe("# Pizza\n");
    expect(await server.callTool("append", { path: "Pizza.md", content: "Dough" })).toBe("Appended to: Pizza.md");
    expect(await vault.read("Pizza.md")).toBe("# Pizza\n\nDough");
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
    await mcpServer(vault, { BACKROOM_GIT: "sync", BACKROOM_PULL_INTERVAL: "0.1" });

    await remote.pushFromOther("Phone.md", "from the phone");

    await eventually(async () => await Bun.file(join(vault.root, "Phone.md")).exists());
    expect(await vault.read("Phone.md")).toBe("from the phone");
  });

  test("in sync mode, exits when the client closes stdin, although the pull timer is running", async () => {
    const vault = await vaultWith({ "A.md": "a" }, "sync");
    const remote = await gitRemote(vault.root);
    cleanup.push(() => remote.remove());
    const server = await mcpServer(vault, { BACKROOM_GIT: "sync", BACKROOM_PULL_INTERVAL: "0.1" });

    await server.process.stdin.end();

    const exit = await Promise.race([server.process.exited, Bun.sleep(5000).then(() => "still running")]);
    expect(exit).toBe(0);
  });
});

describe("configuration", () => {
  test("a pull interval that is not a positive number of seconds is refused", async () => {
    const vault = await vaultWith({});
    const run = Bun.spawn([process.execPath, MAIN, "mcp"], {
      env: { ...process.env, BACKROOM_VAULT: vault.root, BACKROOM_PULL_INTERVAL: "soon" },
      stdin: "ignore",
      stdout: "pipe",
    });

    expect(await run.exited).toBe(1);
    expect(await new Response(run.stdout).text()).toBe(
      'Error: BACKROOM_PULL_INTERVAL must be a positive number of seconds, not "soon".\n',
    );
  });
});
