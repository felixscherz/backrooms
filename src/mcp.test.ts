import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp";
import { tempVault, type TempVault } from "./testing/temp-vault";

let vault: TempVault;
let client: Client;

beforeAll(async () => {
  vault = await tempVault({
    "Pizza.md": "---\ntags: [resource/cooking]\n---\n# Pizza\nDough. See [[Bread]].\n",
    "Bread.md": "# Bread\n",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer(vault.engine).connect(serverTransport);
  client = new Client({ name: "test", version: "1" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await vault.remove();
});

async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { text: content.map((part) => part.text).join(""), isError: result.isError === true };
}

describe("mcp", () => {
  test("every CLI command is a tool, with colons replaced by underscores", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).toContain("search_context");
    expect(names).toContain("property_set");
    expect(names).toContain("read");
  });

  test("a tool returns the same output as the CLI command", async () => {
    const cli = await vault.ok("backlinks", "path=Bread.md", "counts", "format=json");

    expect(await callTool("backlinks", { path: "Bread.md", counts: true, format: "json" })).toEqual({
      text: cli,
      isError: false,
    });
  });

  test("content passed through MCP is taken literally, without \\n escapes", async () => {
    await callTool("create", { path: "Code.md", content: "line one\nprint('\\n')" });

    expect(await vault.read("Code.md")).toBe("line one\nprint('\\n')");
  });

  test("errors are reported as tool errors", async () => {
    expect(await callTool("read", { path: "Missing.md" })).toEqual({
      text: 'Error: File "Missing.md" not found.',
      isError: true,
    });
  });
});
