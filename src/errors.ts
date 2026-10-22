export type ErrorCode =
  /** A file, folder or property the caller named does not exist. */
  | "not_found"
  /** A write would replace a file that already exists. */
  | "already_exists"
  /** The file changed since the version the caller based the write on. */
  | "conflict"
  /** A parameter is missing or malformed. */
  | "invalid_argument"
  /** The vault is in a state where backroom cannot tell how Obsidian would read it, so it refuses to write. */
  | "unsafe"
  /** Obsidian supports this, backroom does not. */
  | "unsupported"
  /** The disk refused a write. The message says whether the vault was left unchanged. */
  | "write_failed"
  /** Another backroom process kept the vault's write lock for too long. */
  | "busy";

/** An error the caller can act on. Its message is meant to be shown to the caller as is. */
export class BackroomError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BackroomError";
  }
}

export function fileNotFound(path: string): BackroomError {
  return new BackroomError("not_found", `File "${path}" not found.`);
}
