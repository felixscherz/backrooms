import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";
import { httpHandler } from "./http";
import { AuthorizationServer, hashPassphrase } from "./oauth";
import { OAuthStore } from "./oauth-store";
import { tempVault, type TempVault } from "./testing/temp-vault";

const ISSUER = "https://backroom.test";
const MCP = `${ISSUER}/mcp`;
const PASSPHRASE = "correct horse battery staple";

/** Claude's hosted apps and Claude Code, with the metadata documents they publish. */
const CLAUDE = {
  clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
};
const CLAUDE_CODE = {
  clientId: "https://claude.ai/oauth/claude-code-client-metadata",
  redirectUri: "http://localhost:53682/callback",
};
const CLIENT_DOCUMENTS: Record<string, unknown> = {
  [CLAUDE.clientId]: {
    client_id: CLAUDE.clientId,
    client_name: "Claude",
    redirect_uris: [CLAUDE.redirectUri],
    token_endpoint_auth_method: "none",
  },
  [CLAUDE_CODE.clientId]: {
    client_id: CLAUDE_CODE.clientId,
    client_name: "Claude Code",
    redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
    token_endpoint_auth_method: "none",
  },
};

let passphraseHash: string;
beforeAll(async () => {
  passphraseHash = await hashPassphrase(PASSPHRASE);
});

const vaults: TempVault[] = [];
afterEach(async () => {
  for (const vault of vaults.splice(0)) await vault.remove();
});

/** backroom over HTTP on a temporary vault, with a clock the test moves and client documents served from memory. */
async function backroom(options: { documents?: Record<string, unknown> } = {}) {
  const vault = await tempVault({ "Pizza.md": "# Pizza\n" });
  vaults.push(vault);
  let now = new Date("2026-10-22T10:00:00Z").getTime();
  const fetched: string[] = [];
  const documents = options.documents ?? CLIENT_DOCUMENTS;
  const store = new OAuthStore();
  const auth = new AuthorizationServer({
    issuer: ISSUER,
    passphraseHash,
    clientOrigins: ["https://claude.ai"],
    store,
    clock: { now: () => new Date(now), timeZone: "UTC" },
    fetchClientMetadata: async (url) => {
      fetched.push(url);
      return url in documents ? Response.json(documents[url] as object) : new Response("not found", { status: 404 });
    },
  });
  const handle = httpHandler(vault.engine, auth);
  const request = (path: string, init?: RequestInit) => handle(new Request(new URL(path, ISSUER).toString(), init));
  return {
    vault,
    store,
    fetched,
    request,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

type Backroom = Awaited<ReturnType<typeof backroom>>;
type Client = { clientId: string; redirectUri: string };

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function authorizeUrl(client: Client, challenge: string, overrides: Record<string, string | null> = {}): string {
  const params: Record<string, string | null> = {
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: MCP,
    ...overrides,
  };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== null) query.set(key, value);
  return `/authorize?${query}`;
}

/** Opens the sign-in page and submits the passphrase, returning the response to the submission. */
async function submitPassphrase(server: Backroom, url: string, passphrase = PASSPHRASE): Promise<Response> {
  const pageResponse = await server.request(url);
  expect(pageResponse.status).toBe(200);
  const requestId = /name="request" value="([^"]+)"/.exec(await pageResponse.text())![1]!;
  return server.request("/authorize", {
    method: "POST",
    body: new URLSearchParams({ request: requestId, passphrase }),
  });
}

function tokenRequest(server: Backroom, params: Record<string, string>) {
  return server.request("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

/** Signs in the way Claude does and returns the tokens. */
async function signIn(server: Backroom, client: Client = CLAUDE) {
  const { verifier, challenge } = pkce();
  const location = new URL((await submitPassphrase(server, authorizeUrl(client, challenge))).headers.get("Location")!);
  const response = await tokenRequest(server, {
    grant_type: "authorization_code",
    code: location.searchParams.get("code")!,
    redirect_uri: client.redirectUri,
    client_id: client.clientId,
    code_verifier: verifier,
    resource: MCP,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { access_token: string; refresh_token: string; expires_in: number };
}

function callTool(server: Backroom, token: string | null, name: string, args: Record<string, unknown>) {
  return server.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
}

async function toolText(response: Response): Promise<string> {
  const body = (await response.json()) as { result: { content: { text: string }[] } };
  return body.result.content.map((part) => part.text).join("");
}

describe("discovery", () => {
  test("the MCP endpoint answers without a token with 401 and points to its metadata", async () => {
    const server = await backroom();

    const response = await callTool(server, null, "read", { path: "Pizza.md" });

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  test("the metadata names the MCP endpoint, backroom as its issuer, PKCE and client metadata documents", async () => {
    const server = await backroom();

    const resource = await (await server.request("/.well-known/oauth-protected-resource/mcp")).json();
    const rootResource = await (await server.request("/.well-known/oauth-protected-resource")).json();
    const issuer = await (await server.request("/.well-known/oauth-authorization-server")).json();

    expect(resource).toEqual({ resource: MCP, authorization_servers: [ISSUER], bearer_methods_supported: ["header"] });
    expect(rootResource).toEqual(resource);
    expect(issuer).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
    });
    expect(issuer).not.toHaveProperty("registration_endpoint");
  });
});

describe("signing in", () => {
  test("Claude signs in with the passphrase and then uses the vault's tools", async () => {
    const server = await backroom();

    const tokens = await signIn(server);
    const response = await callTool(server, tokens.access_token, "read", { path: "Pizza.md" });

    expect(tokens.expires_in).toBe(3600);
    expect(response.status).toBe(200);
    expect(await toolText(response)).toBe("# Pizza\n");
  });

  test("an MCP client connects, lists the tools and calls one over HTTP with its token", async () => {
    const server = await backroom();
    const tokens = await signIn(server);
    const transport = new StreamableHTTPClientTransport(new URL(MCP), {
      fetch: (url, init) => server.request(String(url), init as RequestInit),
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    });
    const client = new McpClient({ name: "test", version: "1" });

    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    const result = await client.callTool({ name: "append", arguments: { path: "Pizza.md", content: "Dough" } });
    await client.close();

    expect(tools).toContain("search_context");
    expect(result.content).toEqual([{ type: "text", text: "Appended to: Pizza.md" }]);
    expect(await server.vault.read("Pizza.md")).toBe("# Pizza\n\nDough");
  });

  test("Claude Code signs in through a loopback redirect on any port", async () => {
    const server = await backroom();

    const tokens = await signIn(server, CLAUDE_CODE);

    expect((await callTool(server, tokens.access_token, "files", {})).status).toBe(200);
  });

  test("the sign-in page names the client and where it redirects, and cannot be framed or run scripts", async () => {
    const server = await backroom();

    const response = await server.request(authorizeUrl(CLAUDE, pkce().challenge));
    const html = await response.text();

    expect(html).toContain("<strong>claude.ai</strong> asks for access to your vault");
    expect(html).toContain("<code>claude.ai</code>");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  test("the sign-in page lets the browser follow the redirect to the client after the form is sent", async () => {
    // Browsers apply form-action to the redirect that answers a form, so the client's origin has to be allowed.
    const server = await backroom();

    const claude = await server.request(authorizeUrl(CLAUDE, pkce().challenge));
    const claudeCode = await server.request(authorizeUrl(CLAUDE_CODE, pkce().challenge));
    const wrong = await submitPassphrase(server, authorizeUrl(CLAUDE, pkce().challenge), "wrong");

    expect(claude.headers.get("Content-Security-Policy")).toContain("form-action 'self' https://claude.ai;");
    expect(claudeCode.headers.get("Content-Security-Policy")).toContain("form-action 'self' http://localhost:53682;");
    expect(wrong.headers.get("Content-Security-Policy")).toContain("form-action 'self' https://claude.ai;");
  });

  test("the redirect carries the code, the state and the issuer", async () => {
    const server = await backroom();

    const response = await submitPassphrase(server, authorizeUrl(CLAUDE, pkce().challenge));
    const location = new URL(response.headers.get("Location")!);

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe(CLAUDE.redirectUri);
    expect(location.searchParams.get("state")).toBe("xyz");
    expect(location.searchParams.get("iss")).toBe(ISSUER);
    expect(location.searchParams.get("code")).toMatch(/^[\w-]{43}$/);
  });

  test("a wrong passphrase shows the page again, and five in a row pause sign-in for 15 minutes", async () => {
    const server = await backroom();
    const url = authorizeUrl(CLAUDE, pkce().challenge);

    const wrong = await submitPassphrase(server, url, "wrong");
    for (let i = 0; i < 4; i++) await submitPassphrase(server, url, "wrong");
    const lockedOut = await submitPassphrase(server, url);
    server.advance(15 * 60_000);
    const later = await submitPassphrase(server, url);

    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("Wrong passphrase.");
    expect(lockedOut.status).toBe(429);
    expect(lockedOut.headers.get("Location")).toBeNull();
    expect(later.status).toBe(302);
  });

  test("wrong passphrases sent at the same time still count one after another", async () => {
    const server = await backroom();
    const url = authorizeUrl(CLAUDE, pkce().challenge);

    const guesses = await Promise.all(Array.from({ length: 20 }, () => submitPassphrase(server, url, "wrong")));
    const afterwards = await submitPassphrase(server, url);

    expect(guesses.filter((response) => response.status === 401)).toHaveLength(5);
    expect(afterwards.status).toBe(429);
  });

  test("only the 100 most recent sign-in pages stay open", async () => {
    const server = await backroom();
    const url = authorizeUrl(CLAUDE, pkce().challenge);
    const first = /name="request" value="([^"]+)"/.exec(await (await server.request(url)).text())![1]!;

    for (let i = 0; i < 100; i++) await server.request(url);
    const response = await server.request("/authorize", {
      method: "POST",
      body: new URLSearchParams({ request: first, passphrase: PASSPHRASE }),
    });

    expect(response.status).toBe(400);
    expect((await submitPassphrase(server, url)).status).toBe(302);
  });

  test("a sign-in page left open for more than 10 minutes expires", async () => {
    const server = await backroom();
    const pageResponse = await server.request(authorizeUrl(CLAUDE, pkce().challenge));
    const requestId = /name="request" value="([^"]+)"/.exec(await pageResponse.text())![1]!;

    server.advance(10 * 60_000);
    const response = await server.request("/authorize", {
      method: "POST",
      body: new URLSearchParams({ request: requestId, passphrase: PASSPHRASE }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("expired");
  });
});

describe("authorization requests that are refused", () => {
  test("clients from other origins, without a metadata URL, or whose metadata is missing get an error page", async () => {
    const server = await backroom();
    const challenge = pkce().challenge;

    const refusals = await Promise.all(
      [
        { clientId: "https://evil.example/client.json", redirectUri: "https://evil.example/callback" },
        { clientId: "claude", redirectUri: CLAUDE.redirectUri },
        { clientId: "http://claude.ai/oauth/x", redirectUri: CLAUDE.redirectUri },
        { clientId: "https://claude.ai/oauth/unknown", redirectUri: CLAUDE.redirectUri },
      ].map(async (client) => {
        const response = await server.request(authorizeUrl(client, challenge));
        return { status: response.status, location: response.headers.get("Location"), text: await response.text() };
      }),
    );

    expect(refusals.map((refusal) => refusal.status)).toEqual([400, 400, 400, 400]);
    expect(refusals.every((refusal) => refusal.location === null)).toBe(true);
    expect(refusals[0]!.text).toContain("evil.example is not a client that may connect to this vault.");
    expect(server.fetched).toEqual(["https://claude.ai/oauth/unknown"]);
  });

  test("a metadata document that names another client is refused", async () => {
    const server = await backroom({
      documents: { [CLAUDE.clientId]: { client_id: "https://claude.ai/other", redirect_uris: [CLAUDE.redirectUri] } },
    });

    const response = await server.request(authorizeUrl(CLAUDE, pkce().challenge));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("names a different client");
  });

  test("a redirect URI the client did not register gets an error page, not a redirect", async () => {
    const server = await backroom();

    const responses = await Promise.all(
      [
        "https://evil.example/callback",
        "https://claude.ai/api/mcp/auth_callback/x",
        "http://evil.localhost/callback",
      ].map((redirectUri) => server.request(authorizeUrl({ ...CLAUDE, redirectUri }, pkce().challenge))),
    );
    const loopbackElsewhere = await server.request(
      authorizeUrl({ ...CLAUDE_CODE, redirectUri: "http://localhost:4000/other" }, pkce().challenge),
    );

    for (const response of [...responses, loopbackElsewhere]) {
      expect(response.status).toBe(400);
      expect(response.headers.get("Location")).toBeNull();
    }
  });

  test("a request without S256 PKCE, for another resource or another response type is sent back with an error", async () => {
    const server = await backroom();
    const challenge = pkce().challenge;

    const cases = {
      noChallenge: authorizeUrl(CLAUDE, challenge, { code_challenge: null }),
      plain: authorizeUrl(CLAUDE, challenge, { code_challenge_method: "plain" }),
      otherResource: authorizeUrl(CLAUDE, challenge, { resource: "https://other.test/mcp" }),
      noResource: authorizeUrl(CLAUDE, challenge, { resource: null }),
      token: authorizeUrl(CLAUDE, challenge, { response_type: "token" }),
    };
    const errors: Record<string, string | null> = {};
    for (const [name, url] of Object.entries(cases)) {
      const location = new URL((await server.request(url)).headers.get("Location")!);
      errors[name] = location.searchParams.get("error");
    }

    expect(errors).toEqual({
      noChallenge: "invalid_request",
      plain: "invalid_request",
      otherResource: "invalid_target",
      noResource: "invalid_target",
      token: "unsupported_response_type",
    });
  });
});

describe("tokens", () => {
  async function code(server: Backroom, client: Client = CLAUDE) {
    const { verifier, challenge } = pkce();
    const location = new URL(
      (await submitPassphrase(server, authorizeUrl(client, challenge))).headers.get("Location")!,
    );
    return { code: location.searchParams.get("code")!, verifier };
  }

  function exchange(server: Backroom, code: string, verifier: string, overrides: Record<string, string> = {}) {
    return tokenRequest(server, {
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE.redirectUri,
      client_id: CLAUDE.clientId,
      code_verifier: verifier,
      resource: MCP,
      ...overrides,
    });
  }

  test("a code is only exchanged with its PKCE verifier, client, redirect URI and resource", async () => {
    const server = await backroom();

    const results: Record<string, unknown> = {};
    const cases: Record<string, Record<string, string>> = {
      verifier: { code_verifier: pkce().verifier },
      client: { client_id: CLAUDE_CODE.clientId },
      redirect: { redirect_uri: "https://claude.ai/other" },
      resource: { resource: "https://other.test/mcp" },
    };
    for (const [name, overrides] of Object.entries(cases)) {
      const { code: issued, verifier } = await code(server);
      results[name] = ((await (await exchange(server, issued, verifier, overrides)).json()) as { error: string }).error;
    }

    expect(results).toEqual({
      verifier: "invalid_grant",
      client: "invalid_grant",
      redirect: "invalid_grant",
      resource: "invalid_target",
    });
  });

  test("a code expires after a minute", async () => {
    const server = await backroom();
    const { code: issued, verifier } = await code(server);

    server.advance(60_000);
    const response = await exchange(server, issued, verifier);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("a code used twice is refused and revokes the tokens of its first use", async () => {
    const server = await backroom();
    const { code: issued, verifier } = await code(server);
    const first = (await (await exchange(server, issued, verifier)).json()) as { access_token: string };

    const second = await exchange(server, issued, verifier);

    expect(second.status).toBe(400);
    expect((await callTool(server, first.access_token, "files", {})).status).toBe(401);
  });

  test("an access token expires after an hour, and a refresh token gives new tokens and stops working", async () => {
    const server = await backroom();
    const tokens = await signIn(server);

    server.advance(60 * 60_000);
    const expired = await callTool(server, tokens.access_token, "files", {});
    const refreshed = await tokenRequest(server, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CLAUDE.clientId,
    });
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };

    expect(expired.status).toBe(401);
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("Cache-Control")).toBe("no-store");
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect((await callTool(server, next.access_token, "files", {})).status).toBe(200);
  });

  test("a refresh token used a second time ends the whole sign-in, since it must have been copied", async () => {
    const server = await backroom();
    const tokens = await signIn(server);
    const refresh = { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: CLAUDE.clientId };
    const next = (await (await tokenRequest(server, refresh)).json()) as {
      access_token: string;
      refresh_token: string;
    };

    const reused = await tokenRequest(server, refresh);

    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ error: "invalid_grant" });
    expect((await callTool(server, next.access_token, "files", {})).status).toBe(401);
    expect((await tokenRequest(server, { ...refresh, refresh_token: next.refresh_token })).status).toBe(400);
  });

  test("a refresh token expires after 30 days without use", async () => {
    const server = await backroom();
    const tokens = await signIn(server);

    server.advance(30 * 24 * 60 * 60_000);
    const response = await tokenRequest(server, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CLAUDE.clientId,
    });

    expect(response.status).toBe(400);
  });

  test("other grant types, unknown tokens and malformed bearer headers are refused", async () => {
    const server = await backroom();
    await signIn(server);

    const grant = await tokenRequest(server, { grant_type: "client_credentials" });
    const unknown = await tokenRequest(server, { grant_type: "refresh_token", refresh_token: "nope" });
    const refreshAsAccess = await signIn(server).then((tokens) => callTool(server, tokens.refresh_token, "files", {}));

    expect(await grant.json()).toMatchObject({ error: "unsupported_grant_type" });
    expect(await unknown.json()).toMatchObject({ error: "invalid_grant" });
    expect(refreshAsAccess.status).toBe(401);
  });

  test("the store keeps only hashes of the secrets it issues", async () => {
    const server = await backroom();
    const tokens = await signIn(server);

    const dump = JSON.stringify(
      (server.store as unknown as { db: { query(sql: string): { all(): unknown } } }).db
        .query("SELECT * FROM credentials")
        .all(),
    );

    expect(dump).not.toContain(tokens.access_token);
    expect(dump).not.toContain(tokens.refresh_token);
  });

  test("auth:revoke ends every sign-in", async () => {
    const server = await backroom();
    const tokens = await signIn(server);

    server.store.revokeAll();

    expect((await callTool(server, tokens.access_token, "files", {})).status).toBe(401);
  });
});
