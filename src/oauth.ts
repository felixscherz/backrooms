import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Clock } from "./clock";
import { newGrantId, type OAuthStore } from "./oauth-store";

/**
 * backroom's OAuth 2.1 authorization server for the one person who owns the vault (ADR 8). Clients identify
 * themselves with a Client ID Metadata Document from an allowed origin, the person signs in with a passphrase, and
 * the tokens it issues are only valid for backroom's MCP endpoint.
 */
export type AuthorizationServerOptions = {
  /** backroom's public URL, such as `https://backroom.example.com`, which is the issuer. */
  issuer: string;
  /** The argon2id hash of the passphrase, as `backroom auth:hash` prints it. */
  passphraseHash: string;
  /** Origins whose Client ID Metadata Documents are accepted, such as `https://claude.ai`. */
  clientOrigins: string[];
  store: OAuthStore;
  clock: Clock;
  /** Fetches a Client ID Metadata Document. A seam, so tests need no network. */
  fetchClientMetadata?: (url: string) => Promise<Response>;
};

const CODE_LIFETIME = 60_000;
const ACCESS_LIFETIME = 60 * 60_000;
const REFRESH_LIFETIME = 30 * 24 * 60 * 60_000;
const PENDING_LIFETIME = 10 * 60_000;
const MAX_PENDING = 100;
const CLIENT_METADATA_CACHE = 10 * 60_000;
const CLIENT_METADATA_MAX_BYTES = 64 * 1024;
/** After this many wrong passphrases in a row, sign-in pauses for LOCKOUT. */
const MAX_FAILURES = 5;
const LOCKOUT = 15 * 60_000;

/** A validated authorization request, waiting for the passphrase. */
type PendingSignIn = {
  client: ClientMetadata;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  expiresAt: number;
};

type ClientMetadata = { clientId: string; redirectUris: string[] };

export class AuthorizationServer {
  readonly issuer: string;
  /** The MCP endpoint, the only resource tokens are issued for. */
  readonly resource: string;
  private readonly pending = new Map<string, PendingSignIn>();
  private readonly clientCache = new Map<string, { metadata: ClientMetadata; until: number }>();
  private failures = 0;
  private lockedUntil = 0;
  /** Passphrases are checked one at a time, so guesses sent together still count towards the pause. */
  private checking: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: AuthorizationServerOptions) {
    this.issuer = options.issuer.replace(/\/+$/, "");
    this.resource = `${this.issuer}/mcp`;
  }

  /** Answers the authorization server's own requests, or returns null for a path it does not serve. */
  async handle(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/.well-known/oauth-protected-resource/mcp") {
      return json(this.protectedResourceMetadata());
    }
    if (request.method === "GET" && path === "/.well-known/oauth-protected-resource") {
      return json(this.protectedResourceMetadata());
    }
    if (request.method === "GET" && path === "/.well-known/oauth-authorization-server") {
      return json(this.authorizationServerMetadata());
    }
    if (path === "/authorize" && request.method === "GET") return this.authorize(new URL(request.url).searchParams);
    if (path === "/authorize" && request.method === "POST")
      return this.signIn(new URLSearchParams(await request.text()));
    if (path === "/token" && request.method === "POST") return this.token(request);
    return null;
  }

  /** Whether the `Authorization` header carries a valid access token for the MCP endpoint. */
  verify(authorization: string | null): boolean {
    const token = /^Bearer (\S+)$/i.exec(authorization ?? "")?.[1];
    if (!token) return false;
    const credential = this.options.store.find(token);
    return (
      credential !== null &&
      credential.kind === "access" &&
      credential.resource === this.resource &&
      credential.expiresAt > this.now()
    );
  }

  /** The `WWW-Authenticate` header of a `401` from the MCP endpoint, which points clients to the metadata. */
  challenge(): string {
    return `Bearer resource_metadata="${this.issuer}/.well-known/oauth-protected-resource/mcp"`;
  }

  private protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      bearer_methods_supported: ["header"],
    };
  }

  private authorizationServerMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  // Authorization endpoint

  /**
   * Checks an authorization request and shows the sign-in page. A request whose client or redirect URI cannot be
   * trusted gets an error page, since redirecting would send the browser somewhere unchecked. Other errors are
   * reported to the client through its redirect URI.
   */
  private async authorize(params: URLSearchParams): Promise<Response> {
    const clientId = params.get("client_id") ?? "";
    const client = await this.client(clientId);
    if (typeof client === "string") return page(400, errorPage(client));
    const redirectUri = params.get("redirect_uri") ?? "";
    if (!client.redirectUris.some((allowed) => redirectMatches(allowed, redirectUri))) {
      return page(400, errorPage(`The redirect URI is not one that ${hostOf(clientId)} registered.`));
    }
    const state = params.get("state");
    const fail = (error: string, description: string) =>
      redirect(redirectUri, { error, error_description: description, state, iss: this.issuer });
    if (params.get("response_type") !== "code")
      return fail("unsupported_response_type", "Only the code flow is supported.");
    const codeChallenge = params.get("code_challenge");
    if (!codeChallenge || params.get("code_challenge_method") !== "S256") {
      return fail("invalid_request", "A PKCE code challenge with method S256 is required.");
    }
    if (params.get("resource") !== this.resource) {
      return fail("invalid_target", `Tokens are only issued for ${this.resource}.`);
    }

    this.forgetExpired();
    // Anyone can open sign-in pages, so only the most recent ones are kept.
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    const id = randomBytes(24).toString("base64url");
    this.pending.set(id, { client, redirectUri, codeChallenge, state, expiresAt: this.now() + PENDING_LIFETIME });
    return page(200, signInPage({ request: id, client: hostOf(clientId), redirect: hostOf(redirectUri) }), redirectUri);
  }

  /** Takes the passphrase for a pending request and, when it is right, sends the client its authorization code. */
  private signIn(form: URLSearchParams): Promise<Response> {
    const step = () => this.checkPassphrase(form);
    const next = this.checking.then(step, step);
    this.checking = next.catch(() => {});
    return next;
  }

  private async checkPassphrase(form: URLSearchParams): Promise<Response> {
    const id = form.get("request") ?? "";
    const pending = this.pending.get(id);
    if (!pending || pending.expiresAt <= this.now()) {
      this.pending.delete(id);
      return page(400, errorPage("This sign-in has expired. Start again from the app."));
    }
    const view = { request: id, client: hostOf(pending.client.clientId), redirect: hostOf(pending.redirectUri) };
    if (this.now() < this.lockedUntil) {
      return page(
        429,
        signInPage({ ...view, error: "Too many wrong passphrases. Try again later." }),
        pending.redirectUri,
      );
    }
    const passphrase = form.get("passphrase") ?? "";
    if (!(await verifyPassphrase(passphrase, this.options.passphraseHash))) {
      this.failures++;
      if (this.failures >= MAX_FAILURES) {
        this.failures = 0;
        this.lockedUntil = this.now() + LOCKOUT;
      }
      return page(401, signInPage({ ...view, error: "Wrong passphrase." }), pending.redirectUri);
    }
    this.failures = 0;
    this.pending.delete(id);
    const code = this.options.store.issue(
      {
        kind: "code",
        grant: newGrantId(),
        clientId: pending.client.clientId,
        resource: this.resource,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
      },
      this.now() + CODE_LIFETIME,
    );
    return redirect(pending.redirectUri, { code, state: pending.state, iss: this.issuer });
  }

  // Token endpoint

  private async token(request: Request): Promise<Response> {
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(await request.text());
    } catch {
      return tokenError("invalid_request", "The request body is not form-encoded.");
    }
    const resource = form.get("resource");
    if (resource !== null && resource !== this.resource) {
      return tokenError("invalid_target", `Tokens are only issued for ${this.resource}.`);
    }
    switch (form.get("grant_type")) {
      case "authorization_code":
        return this.exchangeCode(form);
      case "refresh_token":
        return this.refresh(form);
      default:
        return tokenError("unsupported_grant_type", "Use authorization_code or refresh_token.");
    }
  }

  private exchangeCode(form: URLSearchParams): Response {
    const code = form.get("code") ?? "";
    const credential = this.options.store.find(code);
    if (!credential || credential.kind !== "code") return tokenError("invalid_grant", "Unknown authorization code.");
    if (credential.usedAt !== null || !this.options.store.use(code, this.now())) {
      // A code used twice may have been intercepted, so whatever the first use issued is revoked too.
      this.options.store.revokeGrant(credential.grant);
      return tokenError("invalid_grant", "The authorization code was already used.");
    }
    if (credential.expiresAt <= this.now()) return tokenError("invalid_grant", "The authorization code expired.");
    if (form.get("client_id") !== credential.clientId) {
      return tokenError("invalid_grant", "The code was issued to another client.");
    }
    if (form.get("redirect_uri") !== credential.redirectUri) {
      return tokenError("invalid_grant", "The redirect URI differs from the authorization request.");
    }
    if (!pkceMatches(form.get("code_verifier") ?? "", credential.codeChallenge)) {
      return tokenError("invalid_grant", "The PKCE code verifier does not match.");
    }
    return this.issueTokens(credential.grant, credential.clientId);
  }

  private refresh(form: URLSearchParams): Response {
    const token = form.get("refresh_token") ?? "";
    const credential = this.options.store.find(token);
    if (!credential || credential.kind !== "refresh") return tokenError("invalid_grant", "Unknown refresh token.");
    if (credential.usedAt !== null || !this.options.store.use(token, this.now())) {
      // Refresh tokens rotate, so an old one coming back means it was copied: end the whole sign-in.
      this.options.store.revokeGrant(credential.grant);
      return tokenError("invalid_grant", "The refresh token was already used.");
    }
    if (credential.expiresAt <= this.now()) return tokenError("invalid_grant", "The refresh token expired.");
    if (form.get("client_id") !== null && form.get("client_id") !== credential.clientId) {
      return tokenError("invalid_grant", "The refresh token was issued to another client.");
    }
    return this.issueTokens(credential.grant, credential.clientId);
  }

  private issueTokens(grant: string, clientId: string): Response {
    const now = this.now();
    this.options.store.removeExpired(now);
    const base = { grant, clientId, resource: this.resource };
    const accessToken = this.options.store.issue({ kind: "access", ...base }, now + ACCESS_LIFETIME);
    const refreshToken = this.options.store.issue({ kind: "refresh", ...base }, now + REFRESH_LIFETIME);
    return json(
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_LIFETIME / 1000,
        refresh_token: refreshToken,
      },
      200,
      { "Cache-Control": "no-store" },
    );
  }

  // Clients

  /** The client's metadata, or why it is not accepted. */
  private async client(clientId: string): Promise<ClientMetadata | string> {
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      return "The client did not identify itself with a client metadata URL.";
    }
    if (url.protocol !== "https:" || url.pathname === "/" || url.hash !== "" || url.username !== "") {
      return "The client did not identify itself with a client metadata URL.";
    }
    if (!this.options.clientOrigins.includes(url.origin)) {
      return `${url.host} is not a client that may connect to this vault.`;
    }
    const cached = this.clientCache.get(clientId);
    if (cached && cached.until > this.now()) return cached.metadata;

    const document = await this.fetchClientDocument(clientId);
    if (typeof document === "string") return document;
    if (document.client_id !== clientId) return "The client's metadata names a different client.";
    const redirectUris = document.redirect_uris;
    if (!Array.isArray(redirectUris) || !redirectUris.every((uri) => typeof uri === "string")) {
      return "The client's metadata lists no redirect URIs.";
    }
    const authMethod = document.token_endpoint_auth_method ?? "none";
    if (authMethod !== "none") return "Only public clients are supported.";
    const metadata = { clientId, redirectUris: redirectUris as string[] };
    this.clientCache.set(clientId, { metadata, until: this.now() + CLIENT_METADATA_CACHE });
    return metadata;
  }

  private async fetchClientDocument(clientId: string): Promise<Record<string, unknown> | string> {
    const unreachable = `The client's metadata at ${clientId} could not be read.`;
    try {
      const fetchMetadata =
        this.options.fetchClientMetadata ??
        ((url: string) => fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) }));
      const response = await fetchMetadata(clientId);
      if (!response.ok) return unreachable;
      const body = await response.arrayBuffer();
      if (body.byteLength > CLIENT_METADATA_MAX_BYTES) return unreachable;
      const document: unknown = JSON.parse(new TextDecoder().decode(body));
      return typeof document === "object" && document !== null && !Array.isArray(document)
        ? (document as Record<string, unknown>)
        : unreachable;
    } catch {
      return unreachable;
    }
  }

  private forgetExpired() {
    const now = this.now();
    for (const [id, pending] of this.pending) if (pending.expiresAt <= now) this.pending.delete(id);
  }

  private now(): number {
    return this.options.clock.now().getTime();
  }
}

/** Creates the hash of a passphrase that `BACKROOM_PASSPHRASE_HASH` holds. */
export function hashPassphrase(passphrase: string): Promise<string> {
  return Bun.password.hash(passphrase, { algorithm: "argon2id" });
}

async function verifyPassphrase(passphrase: string, hash: string): Promise<boolean> {
  if (passphrase === "") return false;
  try {
    return await Bun.password.verify(passphrase, hash);
  } catch {
    return false;
  }
}

/**
 * Whether a requested redirect URI is the registered one. Loopback addresses match on any port, since native apps
 * such as Claude Code listen on a port chosen per session (RFC 8252).
 */
export function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  let a: URL;
  let b: URL;
  try {
    a = new URL(registered);
    b = new URL(requested);
  } catch {
    return false;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"];
  return (
    a.protocol === "http:" &&
    b.protocol === "http:" &&
    loopback.includes(a.hostname) &&
    a.hostname === b.hostname &&
    a.pathname === b.pathname &&
    a.search === b.search &&
    b.hash === "" &&
    b.username === "" &&
    b.password === ""
  );
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Responses

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

function tokenError(error: string, description: string): Response {
  return json({ error, error_description: description }, 400, { "Cache-Control": "no-store" });
}

function redirect(uri: string, params: Record<string, string | null>): Response {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value !== null) url.searchParams.set(key, value);
  return new Response(null, { status: 302, headers: { Location: url.toString(), "Cache-Control": "no-store" } });
}

/**
 * An HTML page that cannot be framed, runs no script and only submits its form to backroom. Browsers also apply
 * `form-action` to the redirect that answers the form, so a sign-in page allows the origin of the client's redirect
 * URI, where the redirect with the code goes.
 */
function page(status: number, html: string, redirectUri?: string): Response {
  const formAction = redirectUri === undefined ? "'self'" : `'self' ${new URL(redirectUri).origin}`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'`,
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const STYLE = `body{font-family:system-ui,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
input,button{font:inherit;width:100%;box-sizing:border-box;padding:.6rem;margin:.4rem 0}
.error{color:#b00020}code{word-break:break-all}`;

function signInPage(view: { request: string; client: string; redirect: string; error?: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to backroom</title>
<style>${STYLE}</style></head><body>
<h1>Sign in to backroom</h1>
<p><strong>${escapeHtml(view.client)}</strong> asks for access to your vault. After you sign in, you are sent back to
<code>${escapeHtml(view.redirect)}</code>.</p>
${view.error ? `<p class="error">${escapeHtml(view.error)}</p>` : ""}
<form method="post" action="/authorize">
<input type="hidden" name="request" value="${escapeHtml(view.request)}">
<label for="passphrase">Passphrase</label>
<input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Allow access</button>
</form></body></html>`;
}

function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>backroom</title>
<style>${STYLE}</style></head><body><h1>Cannot sign in</h1><p class="error">${escapeHtml(message)}</p></body></html>`;
}
