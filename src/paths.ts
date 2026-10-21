/** Vault paths are relative to the vault root, use `/` as separator and never start or end with one. */

export function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function extension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1);
}

/** The file name without its extension, which is what Obsidian shows as a note's name. */
export function stem(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

export function join(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}

export function isMarkdown(path: string): boolean {
  return extension(path).toLowerCase() === "md";
}

/** Resolves `.` and `..` segments. Returns null for a path that leaves the vault. */
export function normalize(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

/** The path of `to` relative to the folder `from`, as used in relative links. */
export function relative(from: string, to: string): string {
  const fromParts = from === "" ? [] : from.split("/");
  const toParts = to.split("/");
  let common = 0;
  while (common < fromParts.length && common < toParts.length - 1 && fromParts[common] === toParts[common]) common++;
  const up = fromParts.slice(common).map(() => "..");
  return [...up, ...toParts.slice(common)].join("/");
}

/** Whether a path lies in a hidden file or folder, which Obsidian does not treat as part of the vault. */
export function isHidden(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("."));
}

/** Characters that Obsidian does not allow in file names, or that would break links to the file. */
const FORBIDDEN_NAME_CHARACTERS = /[*"\\/<>:|?#^[\]]/;

export function validateFileName(name: string): string | null {
  if (name.trim() === "" || name.startsWith(".")) return `File name "${name}" is not allowed.`;
  if (FORBIDDEN_NAME_CHARACTERS.test(name)) {
    return `File name "${name}" cannot contain any of the following characters: * " \\ / < > : | ? # ^ [ ]`;
  }
  return null;
}

/** Collation used for every sorted listing, so output order is stable across runs. */
export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "base", numeric: false }) || (a < b ? -1 : a > b ? 1 : 0);
}
