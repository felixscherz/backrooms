# 8. Remote MCP over HTTP with backroom's own OAuth server

- Status: Proposed
- Date: 2026-10-22

## Context

ADR 5 leaves open how remote clients reach the MCP server and authenticate. The client that matters first is the Claude
app on the phone, followed by claude.ai, Claude Desktop and Claude Code. Later, other agents such as opencode may follow.

Claude reaches a custom connector from Anthropic's infrastructure, also when the user is on the phone, so the server
needs a public HTTPS URL. Claude's requirements for it are in its documentation for
[connector authentication](https://claude.com/docs/connectors/building/authentication):

- Sign-in uses OAuth 2.1 with PKCE (`S256`), as the
  [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
  describes. An unauthenticated request gets `401` with a `WWW-Authenticate` header that points to the protected
  resource metadata (RFC 9728), which names the authorization server, whose metadata (RFC 8414) names its endpoints.
- Claude identifies itself either through a Client ID Metadata Document (CIMD), an HTTPS URL as `client_id` that the
  authorization server fetches, or through Dynamic Client Registration (DCR). It uses CIMD when the authorization
  server advertises `client_id_metadata_document_supported` and the `none` token endpoint authentication method.
- The hosted apps (web, desktop, mobile) redirect to `https://claude.ai/api/mcp/auth_callback`. Claude Code identifies
  itself with `https://claude.ai/oauth/claude-code-client-metadata` and redirects to `localhost` on a port that changes
  per session.
- Claude sends the `resource` parameter (RFC 8707), refreshes tokens before they expire, and expects refresh tokens of
  a public client to rotate.
- A fixed API key in a request header is in beta for a few organizations only, and client certificates are not
  supported, so neither can protect a personal server.

backroom serves one person (vision: no multiple users). The VM runs nginx, which terminates TLS for several
subdomains with a Let's Encrypt certificate and proxies to services behind it.

## Decision

backroom serves MCP over the streamable HTTP transport and is its own OAuth authorization server, for one user who
signs in with a passphrase.

### Transport

- `backroom serve` listens on a local address, by default `127.0.0.1:8484`, and nginx proxies a subdomain to it. TLS
  ends at nginx. backroom never builds URLs from request headers: its public URL is configured as `BACKROOM_URL`, for
  example `https://backroom.example.com`.
- The MCP endpoint is `BACKROOM_URL/mcp`, the same tools as over stdio (ADR 5). The transport runs stateless, since
  every tool is one request and one answer, and all requests share one engine, so writes stay serialized (ADR 2) and
  the pull timer of `sync` mode (ADR 6) runs as in `backroom mcp`.

### Authorization server

The authorization server is part of backroom, on the same origin. Its issuer is `BACKROOM_URL`, and the resource it
issues tokens for is `BACKROOM_URL/mcp`.

- **Discovery.** `/mcp` answers requests without a valid token with `401` and
  `WWW-Authenticate: Bearer resource_metadata="BACKROOM_URL/.well-known/oauth-protected-resource/mcp"`. The protected
  resource metadata is served at that path and at `/.well-known/oauth-protected-resource`, the authorization server
  metadata at `/.well-known/oauth-authorization-server`. It advertises the authorization code and refresh token
  grants, `S256`, the `none` authentication method and CIMD. It offers no scopes: a token grants the whole vault.
- **Clients.** Clients identify themselves with a CIMD. backroom accepts a `client_id` only from a configured list of
  origins, by default `https://claude.ai`, which covers the hosted Claude apps and Claude Code. Only those URLs are ever
  fetched, with a short timeout, a size limit and no redirects, so `/authorize` cannot be used to make backroom request
  other addresses. The document's `client_id` has to equal its URL, and the `redirect_uri` has to be one of its
  `redirect_uris`, compared exactly, except that the port of a loopback address (`localhost`, `127.0.0.1`, `[::1]`)
  is ignored. There is no DCR endpoint. Another client, such as opencode, is allowed by adding its origin, or by adding
  DCR then.
- **Sign-in.** `/authorize` checks the request first: a known client, a matching redirect URI, a PKCE `S256`
  challenge, and `resource` equal to `BACKROOM_URL/mcp`. It then shows a page that names the client by the host of
  its `client_id` and the host it redirects to, and asks for the passphrase. backroom stores only an argon2id hash of
  the passphrase, set as `BACKROOM_PASSPHRASE_HASH` and created with `backroom auth:hash`. Failed attempts slow down
  further attempts, and after repeated failures sign-in pauses for a while. The page is tied to the pending request
  server-side, so its form cannot be submitted from another site.
- **Codes and tokens.** After the passphrase is accepted, backroom redirects with a single-use authorization code,
  valid for a minute and bound to the client, the redirect URI, the PKCE challenge and the resource, and with `state`
  and `iss` (RFC 9207). The token endpoint takes form-encoded requests and exchanges a code, with its PKCE verifier,
  for an access token valid for an hour and a refresh token valid for 30 days of not being used. Each refresh returns a
  new refresh token and invalidates the old one. Using an invalidated refresh token again revokes every token of that
  sign-in, since it means the token was copied.
- **Storage.** Tokens are random 256-bit values. backroom stores only their SHA-256 hashes, together with their client,
  resource and expiry, in a SQLite database in its state folder, `BACKROOM_STATE`, outside the vault. Sign-ins survive
  restarts, so a deployment does not ask for the passphrase again. `backroom auth:revoke` revokes every token.

### Alternatives not chosen

- **An external identity provider** (Auth0, WorkOS, Keycloak) would bring a proven OAuth implementation, but adds a
  service to run or depend on for one user, and must support CIMD or DCR together with resource indicators. backroom
  could switch to one later by validating its tokens instead of issuing its own.
- **Sign-in through GitHub** would avoid storing a passphrase, but makes signing in depend on GitHub and needs a
  registered OAuth app.
- **DCR** registers a new client on every connection and lets any client register. CIMD with an allowlist of origins
  needs no registration and admits only known clients.

## Consequences

- Connecting from the Claude app is: add a custom connector with `BACKROOM_URL/mcp`, then enter the passphrase once
  per 30 days of not using it, or after `auth:revoke`.
- backroom carries security-critical code: the authorization and token endpoints, the CIMD fetch, and token storage.
  Each requirement above needs a test, including the refusals: unknown clients, mismatched redirect URIs, a wrong
  PKCE verifier or resource, reused codes, and reused refresh tokens.
- The passphrase is the one secret that protects the vault, so it has to be long and random, and the sign-in page must
  only ever be served over HTTPS.
- A new client needs its origin added to the allowlist, or DCR, before it can connect.
