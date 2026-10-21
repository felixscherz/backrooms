import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { commandSpecs, runCli, type Invocation } from "./cli";
import type { Engine } from "./engine";

/** MCP tool names cannot contain colons, so `search:context` becomes `search_context` (ADR 5). */
export function toolName(command: string): string {
  return command.replace(/:/g, "_");
}

/**
 * Builds an MCP server whose tools are the CLI commands. Each tool takes the command's parameters as named
 * arguments, flags as booleans, and returns the same text the CLI prints, so skills written against the Obsidian
 * CLI read the same output either way.
 */
export function createMcpServer(engine: Engine): McpServer {
  const server = new McpServer({ name: "backroom", version: "0.1.0" });
  for (const spec of commandSpecs()) {
    const shape: Record<string, z.ZodOptional<z.ZodString> | z.ZodOptional<z.ZodBoolean>> = {};
    const flags = new Set<string>();
    for (const param of spec.params) {
      const [name, hint] = param.split("=");
      if (!name) continue;
      if (hint === undefined) {
        flags.add(name);
        shape[name] = z.boolean().optional().describe(`Flag: ${name}`);
      } else {
        shape[name] = z.string().optional().describe(hint);
      }
    }
    server.registerTool(
      toolName(spec.name),
      { description: `${spec.summary}. Same as the Obsidian CLI command "${spec.name}".`, inputSchema: shape },
      async (input: Record<string, string | boolean | undefined>) => {
        const invocation: Invocation = { command: spec.name, params: new Map(), flags: new Set() };
        for (const [key, value] of Object.entries(input)) {
          if (value === undefined || value === false) continue;
          if (flags.has(key)) invocation.flags.add(key);
          else invocation.params.set(key, String(value));
        }
        const result = await runCli(engine, invocation, { unescapeContent: false });
        return { content: [{ type: "text" as const, text: result.output }], isError: result.exitCode !== 0 };
      },
    );
  }
  return server;
}

export async function serveStdio(engine: Engine): Promise<void> {
  const server = createMcpServer(engine);
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => {
    process.stdin.on("close", resolve);
    process.stdin.on("end", resolve);
  });
}
