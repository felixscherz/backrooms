import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname as dirnameFs, join as joinFs } from "node:path";
import { BackroomError } from "./errors";
import { basename, dirname, extension, isHidden, normalize, stem } from "./paths";
import { contentVersion } from "./vault";

/**
 * One step of a planned write. Every step that touches an existing file names the version it was planned
 * against; `null` is only allowed for files whose content backroom does not read, such as attachments.
 */
export type Change =
  | { kind: "create"; path: string; text: string }
  | { kind: "modify"; path: string; baseVersion: string; text: string }
  /** Moves a file, and replaces its content when `text` is given, for example to update links inside it. */
  | { kind: "move"; from: string; to: string; baseVersion: string | null; text?: string }
  | { kind: "trash"; path: string; baseVersion: string | null };

/** What an applied change did, so callers can report it and git can commit exactly these paths. */
export type AppliedChange = Change & { trashPath?: string };

export const TRASH_FOLDER = ".trash";

/**
 * Applies a set of changes to the vault on disk as one unit: all are validated before the first write, each file
 * is replaced atomically, and if a step fails the steps already applied are rolled back.
 */
export async function applyChanges(root: string, changes: Change[]): Promise<AppliedChange[]> {
  for (const change of changes) validatePaths(change);
  await checkPreconditions(root, changes);

  const undo: (() => Promise<void>)[] = [];
  const applied: AppliedChange[] = [];
  try {
    for (const change of changes) applied.push(await applyOne(root, change, undo));
  } catch (error) {
    for (const step of undo.reverse()) {
      try {
        await step();
      } catch {
        // Keep rolling back the other steps. The original error is what the caller needs to see.
      }
    }
    throw error;
  }
  return applied;
}

function validatePaths(change: Change) {
  // Moving a file out of .trash restores it, which is the one way backroom touches a hidden folder.
  const restoring = change.kind === "move" && change.from.startsWith(`${TRASH_FOLDER}/`);
  const paths = change.kind === "move" ? (restoring ? [change.to] : [change.from, change.to]) : [change.path];
  for (const path of paths) {
    if (normalize(path) !== path || path === "") {
      throw new BackroomError("invalid_argument", `Path "${path}" is not a valid vault path.`);
    }
    if (isHidden(path)) {
      throw new BackroomError(
        "invalid_argument",
        `Path "${path}" is in a hidden folder, which backroom does not touch.`,
      );
    }
  }
}

async function checkPreconditions(root: string, changes: Change[]) {
  for (const change of changes) {
    switch (change.kind) {
      case "create":
        if (await exists(root, change.path)) throw alreadyExists(change.path);
        break;
      case "modify":
        await checkVersion(root, change.path, change.baseVersion);
        break;
      case "move":
        await checkVersion(root, change.from, change.baseVersion);
        if (change.from.toLowerCase() !== change.to.toLowerCase() && (await exists(root, change.to))) {
          throw alreadyExists(change.to);
        }
        break;
      case "trash":
        await checkVersion(root, change.path, change.baseVersion);
        break;
    }
  }
}

async function applyOne(root: string, change: Change, undo: (() => Promise<void>)[]): Promise<AppliedChange> {
  switch (change.kind) {
    case "create": {
      const created = await ensureFolder(root, dirname(change.path));
      undo.push(() => removeFolders(root, created));
      await atomicWrite(root, change.path, change.text, { mustNotExist: true });
      undo.push(() => unlink(joinFs(root, change.path)));
      return change;
    }
    case "modify": {
      const original = await readFile(joinFs(root, change.path), "utf8");
      await checkVersion(root, change.path, change.baseVersion);
      await atomicWrite(root, change.path, change.text, { mustNotExist: false });
      undo.push(() => atomicWrite(root, change.path, original, { mustNotExist: false }));
      return change;
    }
    case "move": {
      await checkVersion(root, change.from, change.baseVersion);
      const created = await ensureFolder(root, dirname(change.to));
      undo.push(() => removeFolders(root, created));
      const original = change.text === undefined ? null : await readFile(joinFs(root, change.from), "utf8");
      await moveFile(root, change.from, change.to);
      undo.push(() => moveFile(root, change.to, change.from));
      if (change.text !== undefined && original !== null) {
        await atomicWrite(root, change.to, change.text, { mustNotExist: false });
        undo.push(() => atomicWrite(root, change.to, original, { mustNotExist: false }));
      }
      return change;
    }
    case "trash": {
      await checkVersion(root, change.path, change.baseVersion);
      await ensureFolder(root, TRASH_FOLDER);
      const trashPath = await freeTrashPath(root, change.path);
      await rename(joinFs(root, change.path), joinFs(root, trashPath));
      undo.push(() => rename(joinFs(root, trashPath), joinFs(root, change.path)));
      return { ...change, trashPath };
    }
  }
}

async function checkVersion(root: string, path: string, baseVersion: string | null) {
  let text: string;
  try {
    text = baseVersion === null ? "" : await readFile(joinFs(root, path), "utf8");
    if (baseVersion === null) await lstat(joinFs(root, path));
  } catch {
    throw new BackroomError("not_found", `File "${path}" not found.`);
  }
  if (baseVersion !== null && contentVersion(text) !== baseVersion) {
    throw new BackroomError(
      "conflict",
      `File "${path}" changed since version ${baseVersion}. Read it again and retry the change.`,
    );
  }
}

/** Writes a file through a temporary file in the same folder and a rename, so readers never see a partial file. */
async function atomicWrite(root: string, path: string, text: string, options: { mustNotExist: boolean }) {
  const target = joinFs(root, path);
  const temporary = joinFs(dirnameFs(target), `.${basename(path)}.backroom-${randomBytes(6).toString("hex")}`);
  const mode = options.mustNotExist ? undefined : (await stat(target).catch(() => null))?.mode;
  await writeFile(temporary, text, { encoding: "utf8", flag: "wx", ...(mode === undefined ? {} : { mode }) });
  try {
    if (options.mustNotExist && (await exists(root, path))) throw alreadyExists(path);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Renames a file. A rename that only changes case goes through a temporary name for case-insensitive disks. */
async function moveFile(root: string, from: string, to: string) {
  if (from.toLowerCase() === to.toLowerCase() && from !== to) {
    const temporary = `${dirname(from) === "" ? "" : `${dirname(from)}/`}.backroom-${randomBytes(6).toString("hex")}`;
    await rename(joinFs(root, from), joinFs(root, temporary));
    await rename(joinFs(root, temporary), joinFs(root, to));
    return;
  }
  if (await exists(root, to)) throw alreadyExists(to);
  await rename(joinFs(root, from), joinFs(root, to));
}

async function freeTrashPath(root: string, path: string): Promise<string> {
  const ext = extension(path);
  const name = stem(path);
  for (let n = 0; ; n++) {
    const candidate = `${TRASH_FOLDER}/${n === 0 ? name : `${name} ${n}`}${ext ? `.${ext}` : ""}`;
    if (!(await exists(root, candidate))) return candidate;
  }
}

/** Creates missing folders and returns the ones it created, deepest last. */
async function ensureFolder(root: string, folder: string): Promise<string[]> {
  const created: string[] = [];
  const parts = folder === "" ? [] : folder.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join("/");
    if (!(await exists(root, path))) {
      await mkdir(joinFs(root, path));
      created.push(path);
    }
  }
  return created;
}

async function removeFolders(root: string, folders: string[]) {
  for (const folder of [...folders].reverse()) await rmdir(joinFs(root, folder)).catch(() => {});
}

async function exists(root: string, path: string): Promise<boolean> {
  try {
    await lstat(joinFs(root, path));
    return true;
  } catch {
    return false;
  }
}

function alreadyExists(path: string): BackroomError {
  return new BackroomError("already_exists", `File "${path}" already exists.`);
}
