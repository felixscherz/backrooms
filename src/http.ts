import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Engine } from "./engine";
import { createMcpServer } from "./mcp";
import type { AuthorizationServer } from "./oauth";

/**
 * backroom over HTTP (ADR 8): the MCP endpoint at `/mcp`, open only with an access token, and the authorization
 * server that issues those tokens. All requests share the engine, so writes stay in turn.
 */
export function httpHandler(engine: Engine, auth: AuthorizationServer): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/mcp") {
      if (!auth.verify(request.headers.get("Authorization"))) {
        return Response.json(
          { error: "invalid_token", error_description: "Sign in to use this vault." },
          { status: 401, headers: { "WWW-Authenticate": auth.challenge() } },
        );
      }
      // Stateless: every request gets its own transport, since each tool call is one request and one answer.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = createMcpServer(engine);
      await server.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        await server.close();
      }
    }
    return (await auth.handle(request)) ?? new Response("Not found", { status: 404 });
  };
}

export type ServeOptions = { hostname: string; port: number; pullIntervalMs: number };

/** Serves backroom over HTTP until the process is stopped, pulling from the remote every interval in sync mode. */
export function serveHttp(engine: Engine, auth: AuthorizationServer, options: ServeOptions) {
  const server = Bun.serve({ hostname: options.hostname, port: options.port, fetch: httpHandler(engine, auth) });
  const timer = engine.git?.mode === "sync" ? setInterval(() => void engine.pull(), options.pullIntervalMs) : null;
  return {
    url: server.url,
    stop: async () => {
      if (timer) clearInterval(timer);
      await server.stop();
    },
  };
}
