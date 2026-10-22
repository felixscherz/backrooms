import { BackroomsError, fileNotFound } from "./errors";
import { parseWikilinkInner, type Link, type Note, type Span } from "./note";
import {
  basename,
  dirname,
  extension,
  isHidden,
  isMarkdown,
  normalize,
  relative,
  stem,
  validateFileName,
} from "./paths";
import { Vault, type Entry } from "./vault";
import type { Change } from "./write";

/**
 * Plans moving or renaming a file and updating every link to it, the way Obsidian does with "Automatically update
 * internal links" on. Links that point elsewhere but would resolve differently after the move are updated too, so
 * after the move every link points at the same file as before. A move that cannot achieve that is rejected.
 */
export function planMove(vault: Vault, from: string, to: string): Change[] {
  const source = vault.entry(from);
  if (!source) throw fileNotFound(from);
  checkDestination(vault, from, to);
  if (from === to) return [];

  const moved: Entry = { ...source, path: to };
  const after = vault.withChanges([moved], [from]);
  const newPath = (path: string) => (path === from ? to : path);

  const texts = new Map<string, string>();
  for (const oldSource of vault.markdownPaths()) {
    const newSource = newPath(oldSource);
    const text = vault.text(oldSource);
    const rewrites: Rewrite[] = [];
    const before = vault.outgoing(oldSource);
    const now = after.outgoing(newSource);
    before.forEach(({ link, target }, index) => {
      if (target === null || (target === oldSource && link.target === "")) return;
      // Links to the moved file are always written anew, like Obsidian does. Other links only when the move would
      // make them point somewhere else.
      const wanted = newPath(target);
      if (target !== from && now[index]?.target === wanted) return;
      rewrites.push({ link, pathText: linkPathFor(after, wanted, newSource, link) });
    });
    const rewritten = rewrites.length > 0 ? applyRewrites(text, vault.note(oldSource), rewrites) : text;
    if (rewritten !== text) texts.set(newSource, rewritten);
  }

  const changedEntries = [...texts].map(([path, text]): Entry => ({ ...(after.entry(path) as Entry), text }));
  const result = after.withChanges(changedEntries, []);
  verifyLinksKeepTargets(vault, result, newPath, to);

  const changes: Change[] = [];
  for (const [path, text] of texts) {
    if (path === to) continue;
    changes.push({ kind: "modify", path, baseVersion: vault.version(path), text });
  }
  changes.push({
    kind: "move",
    from,
    to,
    baseVersion: isMarkdown(from) ? vault.version(from) : null,
    ...(texts.has(to) ? { text: texts.get(to)! } : {}),
  });
  return changes;
}

function checkDestination(vault: Vault, from: string, to: string) {
  if (normalize(to) !== to || to === "" || isHidden(to)) {
    throw new BackroomsError("invalid_argument", `"${to}" is not a valid destination in the vault.`);
  }
  const nameError = validateFileName(stem(to));
  if (nameError) throw new BackroomsError("invalid_argument", nameError);
  if (extension(from).toLowerCase() !== extension(to).toLowerCase()) {
    throw new BackroomsError("invalid_argument", `Moving "${from}" to "${to}" would change its file extension.`);
  }
  const existing = vault.fileIgnoringCase(to);
  if (existing && existing.path !== from)
    throw new BackroomsError("already_exists", "Destination file already exists!");
  const folderClash = vault.folders().find((folder) => folder.toLowerCase() === to.toLowerCase());
  if (folderClash) throw new BackroomsError("already_exists", `A folder "${folderClash}" already exists.`);
}

/**
 * The link path to write for a link to `target` from `source`, following the vault's link format and keeping the
 * link's own style: wikilinks to notes leave out `.md`, also when the link had it, like Obsidian, and markdown links
 * are URL encoded.
 */
function linkPathFor(vault: Vault, target: string, source: string, link: Link): string {
  const keepExtension = !isMarkdown(target) || link.syntax === "markdown";
  const withoutExtension = (path: string) => (keepExtension ? path : path.replace(/\.md$/i, ""));
  const name = withoutExtension(basename(target));
  const candidates: string[] = [];
  switch (vault.settings.newLinkFormat) {
    case "shortest":
      if (vault.filesNamed(basename(target)).length === 1) candidates.push(name);
      break;
    case "relative":
      candidates.push(withoutExtension(relative(dirname(source), target)));
      break;
    case "absolute":
      break;
  }
  candidates.push(withoutExtension(target));
  const path = candidates.find((candidate) => vault.resolve(candidate, source) === target);
  if (path === undefined) {
    throw new BackroomsError("unsafe", `No link from "${source}" can point to "${target}" unambiguously.`);
  }
  return path;
}

type Rewrite = { link: Link; pathText: string };

/** Replaces the path part of each link, keeping its subpath, display text and everything around it. */
function applyRewrites(text: string, note: Note, rewrites: Rewrite[]): string {
  const replacements: { span: Span; text: string }[] = [];
  if (rewrites.some((rewrite) => rewrite.link.location.kind === "property")) {
    replacements.push(...propertyReplacements(text, note, rewrites));
  }
  for (const { link, pathText } of rewrites) {
    if (link.location.kind !== "body") continue;
    const span = link.location.span;
    replacements.push({ span: pathSpan(text, span, link), text: encodePath(pathText, text, span, link) });
  }
  replacements.sort((a, b) => b.span.start - a.span.start);
  let result = text;
  for (const { span, text: replacement } of replacements) {
    result = result.slice(0, span.start) + replacement + result.slice(span.end);
  }
  return result;
}

/** Where the path of a link sits within the link's span. */
function pathSpan(text: string, span: Span, link: Link): Span {
  const raw = text.slice(span.start, span.end);
  if (link.syntax === "wikilink") {
    const open = raw.indexOf("[[") + 2;
    const inner = raw.slice(open, -2);
    let end = inner.search(/[#|]/);
    if (end === -1) end = inner.length;
    else if (inner[end] === "|" && inner[end - 1] === "\\") end--;
    return { start: span.start + open, end: span.start + open + end };
  }
  const destination = raw.lastIndexOf("](") + 2;
  const rest = raw.slice(destination);
  const leading = rest.length - rest.trimStart().length;
  const angled = rest.trimStart().startsWith("<");
  const start = destination + leading + (angled ? 1 : 0);
  // A path in angle brackets may contain spaces and ends at ">", a plain one ends at whitespace or ")".
  const stop = angled ? /[#>]/ : /[#\s)]/;
  let end = start;
  while (end < raw.length && !stop.test(raw[end]!)) end++;
  return { start: span.start + start, end: span.start + end };
}

function encodePath(path: string, text: string, span: Span, link: Link): string {
  if (link.syntax === "wikilink") return path;
  const raw = text.slice(span.start, span.end);
  const angled = raw
    .slice(raw.lastIndexOf("](") + 2)
    .trimStart()
    .startsWith("<");
  return angled ? path : encodeURI(path).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/**
 * Property links have no span of their own, so they are matched to the wikilinks in the frontmatter text in order.
 * When the two do not line up, for example because a YAML comment holds a link, the rewrite is refused.
 */
function propertyReplacements(text: string, note: Note, rewrites: Rewrite[]): { span: Span; text: string }[] {
  if (note.frontmatter.kind !== "valid") {
    throw new BackroomsError("unsafe", "Links in invalid frontmatter cannot be updated safely.");
  }
  const yamlStart = note.frontmatter.yamlSpan.start;
  const yaml = text.slice(yamlStart, note.frontmatter.yamlSpan.end);
  const occurrences = [...yaml.matchAll(/(!?)\[\[([^[\]\n]+?)\]\]/g)];
  const propertyLinks = note.links.filter((link) => link.location.kind === "property");
  const unmatched = () =>
    new BackroomsError(
      "unsafe",
      "The links in the frontmatter cannot be matched to properties, so they cannot be updated safely.",
    );
  if (occurrences.length !== propertyLinks.length) throw unmatched();

  const result: { span: Span; text: string }[] = [];
  occurrences.forEach((match, index) => {
    const rewrite = rewrites.find((candidate) => candidate.link === propertyLinks[index]);
    if (!rewrite) return;
    const inner = match[2]!;
    if (parseWikilinkInner(inner).target !== rewrite.link.target) throw unmatched();
    let end = inner.search(/[#|]/);
    if (end === -1) end = inner.length;
    else if (inner[end] === "|" && inner[end - 1] === "\\") end--;
    const start = yamlStart + match.index + match[1]!.length + 2;
    result.push({ span: { start, end: start + end }, text: rewrite.pathText });
  });
  return result;
}

/** Checks that every link that pointed at a file still points at it, at its new path. */
function verifyLinksKeepTargets(before: Vault, after: Vault, newPath: (path: string) => string, to: string) {
  const broken: string[] = [];
  for (const oldSource of before.markdownPaths()) {
    const newSource = newPath(oldSource);
    const old = before.outgoing(oldSource);
    const now = after.outgoing(newSource);
    if (old.length !== now.length) {
      broken.push(newSource);
      continue;
    }
    old.forEach(({ target }, index) => {
      const nowTarget = now[index]!.target;
      // A link that pointed nowhere may now point at the moved file, because it got the name the link uses.
      const kept = target === null ? nowTarget === null || nowTarget === to : newPath(target) === nowTarget;
      if (!kept) {
        broken.push(`${newSource} (${old[index]!.link.target})`);
      }
    });
  }
  if (broken.length > 0) {
    throw new BackroomsError("unsafe", `The move would change where these links point: ${broken.join(", ")}.`);
  }
}
