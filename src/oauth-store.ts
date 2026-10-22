import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";

/**
 * What a sign-in left behind: authorization codes, access tokens and refresh tokens, each bound to the sign-in (the
 * grant) it came from. Only SHA-256 hashes of the secrets are stored, so a copy of the database does not let anyone
 * in (ADR 8).
 */
export type Credential =
  | { kind: "code"; grant: string; clientId: string; resource: string; redirectUri: string; codeChallenge: string }
  | { kind: "access"; grant: string; clientId: string; resource: string }
  | { kind: "refresh"; grant: string; clientId: string; resource: string };

export type StoredCredential = Credential & {
  expiresAt: number;
  /** When a code or refresh token was exchanged, or null while it is unused. */
  usedAt: number | null;
};

/** The SQLite database of backroom's authorization server, in its state folder or in memory for tests. */
export class OAuthStore {
  private readonly db: Database;

  constructor(path: string = ":memory:") {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS credentials (
      hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      redirect_uri TEXT,
      code_challenge TEXT,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS credentials_by_grant ON credentials (grant_id)");
  }

  /** Stores a new credential and returns its secret, which is never stored and cannot be looked up again. */
  issue(credential: Credential, expiresAt: number): string {
    const secret = randomBytes(32).toString("base64url");
    this.db
      .query(
        `INSERT INTO credentials (hash, kind, grant_id, client_id, resource, redirect_uri, code_challenge, expires_at)
         VALUES ($hash, $kind, $grant, $clientId, $resource, $redirectUri, $codeChallenge, $expiresAt)`,
      )
      .run({
        hash: hashOf(secret),
        kind: credential.kind,
        grant: credential.grant,
        clientId: credential.clientId,
        resource: credential.resource,
        redirectUri: credential.kind === "code" ? credential.redirectUri : null,
        codeChallenge: credential.kind === "code" ? credential.codeChallenge : null,
        expiresAt,
      });
    return secret;
  }

  /** The credential with this secret, also when it is expired or used, or null when there is none. */
  find(secret: string): StoredCredential | null {
    const row = this.db
      .query("SELECT * FROM credentials WHERE hash = $hash")
      .get({ hash: hashOf(secret) }) as Row | null;
    return row ? fromRow(row) : null;
  }

  /** Marks a code or refresh token as exchanged. Returns false when it already was, so only one exchange wins. */
  use(secret: string, at: number): boolean {
    const result = this.db
      .query("UPDATE credentials SET used_at = $at WHERE hash = $hash AND used_at IS NULL")
      .run({ hash: hashOf(secret), at });
    return result.changes === 1;
  }

  /** Revokes everything a sign-in issued. */
  revokeGrant(grant: string): void {
    this.db.query("DELETE FROM credentials WHERE grant_id = $grant").run({ grant });
  }

  /** Revokes every sign-in. Returns how many credentials were removed. */
  revokeAll(): number {
    return this.db.query("DELETE FROM credentials").run().changes;
  }

  /** Removes credentials that expired before the time. Used ones are kept until then, to notice a reuse. */
  removeExpired(before: number): void {
    this.db.query("DELETE FROM credentials WHERE expires_at < $before").run({ before });
  }

  close(): void {
    this.db.close();
  }
}

export function newGrantId(): string {
  return randomBytes(16).toString("hex");
}

function hashOf(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

type Row = {
  kind: "code" | "access" | "refresh";
  grant_id: string;
  client_id: string;
  resource: string;
  redirect_uri: string | null;
  code_challenge: string | null;
  expires_at: number;
  used_at: number | null;
};

function fromRow(row: Row): StoredCredential {
  const common = {
    grant: row.grant_id,
    clientId: row.client_id,
    resource: row.resource,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
  };
  if (row.kind === "code") {
    return { kind: "code", ...common, redirectUri: row.redirect_uri!, codeChallenge: row.code_challenge! };
  }
  return { kind: row.kind, ...common };
}
