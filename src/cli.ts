import { Engine, type FileRef, type FileTarget, type OutlineHeading, type TagCount, type WriteResult } from "./engine";
import { BackroomError } from "./errors";
import { propertyValueTypes, type PropertyValueType } from "./frontmatter";
import type { JsonValue } from "./note";
import { compareNames } from "./paths";

/** Parsed command line: the command, its `key=value` parameters and its bare flags. */
export type Invocation = { command: string; params: Map<string, string>; flags: Set<string> };

export type CliResult = { output: string; exitCode: number };

/** The command is the first argument without `=`, so options such as `vault=` may come before it. */
export function parseArguments(argv: string[]): Invocation {
  let command: string | undefined;
  const params = new Map<string, string>();
  const flags = new Set<string>();
  for (const argument of argv) {
    const equals = argument.indexOf("=");
    if (equals > 0) params.set(argument.slice(0, equals), argument.slice(equals + 1));
    else if (command === undefined) command = argument;
    else flags.add(argument);
  }
  return { command: command ?? "help", params, flags };
}

type Args = {
  /** A parameter's value, or undefined when it was not given. */
  get(name: string): string | undefined;
  required(name: string): string;
  /** A content parameter, with `\n` and `\t` turned into newline and tab like the Obsidian CLI does. */
  content(name: string): string | undefined;
  flag(name: string): boolean;
  format<F extends string>(allowed: readonly F[], fallback: F): F;
  ref(): FileRef;
  optionalRef(): FileRef | undefined;
};

type Command = {
  summary: string;
  params: string[];
  run(engine: Engine, args: Args): Promise<string>;
};

/** Obsidian CLI commands that backroom deliberately does not implement, with the reason shown to the caller. */
const UNSUPPORTED: Record<string, string> = {
  open: "backroom has no app to open files in.",
  command: "backroom cannot run Obsidian commands or plugins, such as the Linter.",
  "search:open": "backroom has no search view.",
  "tab:open": "backroom has no tabs.",
  random: "backroom has no app to open files in.",
};

const commands: Record<string, Command> = {
  read: {
    summary: "Read file contents",
    params: ["file=<name>", "path=<path>"],
    run: async (engine, args) => (await engine.read(args.ref())).text,
  },
  file: {
    summary: "Show file info, including the version that writes can be checked against",
    params: ["file=<name>", "path=<path>"],
    run: async (engine, args) => {
      const info = await engine.fileInfo(args.ref());
      const rows: [string, string | number][] = [
        ["path", info.path],
        [
          "name",
          info.path
            .split("/")
            .pop()!
            .replace(/\.[^.]+$/, ""),
        ],
        ["extension", info.path.includes(".") ? info.path.split(".").pop()! : ""],
        ["size", info.size],
        ["created", Math.round(info.created)],
        ["modified", Math.round(info.modified)],
      ];
      if (info.version !== null) rows.push(["version", info.version]);
      return tsv(rows);
    },
  },
  outline: {
    summary: "Show headings of a file",
    params: ["file=<name>", "path=<path>", "format=tree|md|json", "total"],
    run: async (engine, args) => {
      const headings = await engine.outline(args.ref());
      if (args.flag("total")) return String(headings.length);
      if (headings.length === 0) return "No headings found.";
      switch (args.format(["tree", "md", "json"] as const, "tree")) {
        case "json":
          return json(headings);
        case "md":
          return lines(headings.map((heading) => `${"#".repeat(heading.level)} ${heading.heading}`));
        case "tree":
          return outlineTree(headings);
      }
    },
  },
  properties: {
    summary: "List properties of a file, or all properties in the vault",
    params: ["file=<name>", "path=<path>", "name=<name>", "total", "sort=count", "counts", "format=yaml|json|tsv"],
    run: async (engine, args) => {
      const ref = args.optionalRef();
      if (ref) {
        const frontmatter = await engine.properties(ref);
        if (!frontmatter) return "No frontmatter found.";
        const { properties, yaml } = frontmatter;
        if (args.flag("total")) return String(Object.keys(properties).length);
        switch (args.format(["yaml", "json", "tsv"] as const, "yaml")) {
          case "json":
            return json(properties);
          case "tsv":
            return tsv(Object.entries(properties).map(([name, value]) => [name, scalarText(value)]));
          case "yaml":
            return yaml.replace(/\r?\n$/, "");
        }
      }
      let names = await engine.propertyNames();
      const name = args.get("name");
      if (name !== undefined) return String(names.find((entry) => entry.name === name)?.count ?? 0);
      if (args.flag("total")) return String(names.length);
      if (args.get("sort") === "count")
        names = [...names].sort((a, b) => b.count - a.count || compareNames(a.name, b.name));
      const counts = args.flag("counts");
      switch (args.format(["yaml", "json", "tsv"] as const, "yaml")) {
        case "json":
          return json(
            names.map((entry) => (counts ? { name: entry.name, count: String(entry.count) } : { name: entry.name })),
          );
        case "tsv":
          return tsv(names.map((entry) => (counts ? [entry.name, entry.count] : [entry.name])));
        case "yaml":
          return lines(names.map((entry) => (counts ? `${entry.name}: ${entry.count}` : entry.name)));
      }
    },
  },
  "property:read": {
    summary: "Read a property value from a file",
    params: ["name=<name>", "file=<name>", "path=<path>"],
    run: async (engine, args) => {
      const value = await engine.propertyRead(args.ref(), args.required("name"));
      return Array.isArray(value) ? lines(value.map(scalarText)) : scalarText(value);
    },
  },
  "property:set": {
    summary: "Set a property on a file",
    params: ["name=<name>", "value=<value>", `type=${propertyValueTypes.join("|")}`, "file=<name>", "path=<path>"],
    run: async (engine, args) => {
      const type = args.get("type");
      if (type !== undefined && !propertyValueTypes.includes(type as PropertyValueType)) {
        throw new BackroomError(
          "invalid_argument",
          `Invalid type "${type}". Use one of ${propertyValueTypes.join(", ")}.`,
        );
      }
      const result = await engine.propertySet(
        args.ref(),
        args.required("name"),
        args.required("value"),
        type as PropertyValueType | undefined,
      );
      return reported(result);
    },
  },
  "property:remove": {
    summary: "Remove a property from a file",
    params: ["name=<name>", "file=<name>", "path=<path>"],
    run: async (engine, args) => reported(await engine.propertyRemove(args.ref(), args.required("name"))),
  },
  tags: {
    summary: "List tags of a file, or all tags in the vault",
    params: ["file=<name>", "path=<path>", "total", "counts", "sort=count", "format=json|tsv|csv"],
    run: async (engine, args) => {
      const ref = args.optionalRef();
      let tags: TagCount[] = ref ? await engine.tagsOf(ref) : await engine.tags();
      if (args.flag("total")) return String(tags.length);
      if (tags.length === 0) return "No tags found.";
      if (args.get("sort") === "count")
        tags = [...tags].sort((a, b) => b.count - a.count || compareNames(a.tag, b.tag));
      const counts = args.flag("counts");
      const format = args.format(["tsv", "json", "csv"] as const, "tsv");
      if (format === "json") {
        return json(
          tags.map((entry) =>
            counts ? { tag: `#${entry.tag}`, count: String(entry.count) } : { tag: `#${entry.tag}` },
          ),
        );
      }
      const rows = tags.map((entry) => (counts ? [`#${entry.tag}`, entry.count] : [`#${entry.tag}`]));
      return format === "csv" ? csv(rows) : tsv(rows);
    },
  },
  tag: {
    summary: "Get tag info",
    params: ["name=<tag>", "total", "verbose"],
    run: async (engine, args) => {
      const { tag, count, files } = await engine.tag(args.required("name"));
      if (args.flag("total")) return String(count);
      return args.flag("verbose") ? lines([`#${tag}\t${count}`, ...files]) : lines(files);
    },
  },
  aliases: {
    summary: "List aliases in the vault, or of a file",
    params: ["file=<name>", "path=<path>", "total", "verbose"],
    run: async (engine, args) => {
      const aliases = await engine.aliases(args.optionalRef());
      if (args.flag("total")) return String(aliases.length);
      if (aliases.length === 0) return "No aliases found.";
      return args.flag("verbose")
        ? tsv(aliases.map((entry) => [entry.alias, entry.path]))
        : lines(aliases.map((entry) => entry.alias));
    },
  },
  links: {
    summary: "List outgoing links from a file",
    params: ["file=<name>", "path=<path>", "total"],
    run: async (engine, args) => {
      const links = await engine.links(args.ref());
      if (args.flag("total")) return String(links.length);
      if (links.length === 0) return "No links found.";
      return lines(links.map((link) => (link.resolved ? link.target : `${link.target} (unresolved)`)));
    },
  },
  backlinks: {
    summary: "List backlinks to a file",
    params: ["file=<name>", "path=<path>", "counts", "total", "format=json|tsv|csv"],
    run: async (engine, args) => {
      const backlinks = await engine.backlinks(args.ref());
      if (args.flag("total")) return String(backlinks.length);
      if (backlinks.length === 0) return "No backlinks found.";
      const counts = args.flag("counts");
      const format = args.format(["tsv", "json", "csv"] as const, "tsv");
      if (format === "json") {
        return json(
          backlinks.map((entry) => (counts ? { file: entry.file, count: String(entry.count) } : { file: entry.file })),
        );
      }
      const rows = backlinks.map((entry) => (counts ? [entry.file, entry.count] : [entry.file]));
      return format === "csv" ? csv(rows) : tsv(rows);
    },
  },
  unresolved: {
    summary: "List unresolved links in vault",
    params: ["total", "counts", "verbose", "format=json|tsv|csv"],
    run: async (engine, args) => {
      const unresolved = await engine.unresolved();
      if (args.flag("total")) return String(unresolved.length);
      const verbose = args.flag("verbose");
      const counts = args.flag("counts") || verbose;
      const format = args.format(["tsv", "json", "csv"] as const, "tsv");
      if (format === "json") {
        return json(
          unresolved.map((entry) => ({
            link: entry.link,
            ...(counts ? { count: String(entry.count) } : {}),
            ...(verbose ? { sources: entry.sources.join(", ") } : {}),
          })),
        );
      }
      const rows = unresolved.map((entry) => [
        entry.link,
        ...(counts ? [entry.count] : []),
        ...(verbose ? [entry.sources.join(", ")] : []),
      ]);
      return format === "csv" ? csv(rows) : tsv(rows);
    },
  },
  orphans: {
    summary: "List files with no incoming links",
    params: ["total", "all"],
    run: async (engine, args) => {
      const orphans = await engine.orphans();
      return args.flag("total") ? String(orphans.length) : lines(orphans);
    },
  },
  deadends: {
    summary: "List files with no outgoing links",
    params: ["total", "all"],
    run: async (engine, args) => {
      const deadends = await engine.deadends();
      return args.flag("total") ? String(deadends.length) : lines(deadends);
    },
  },
  files: {
    summary: "List files in the vault",
    params: ["folder=<path>", "ext=<extension>", "total"],
    run: async (engine, args) => {
      const files = await engine.files({ folder: args.get("folder"), ext: args.get("ext") });
      return args.flag("total") ? String(files.length) : lines(files.map((file) => file.path));
    },
  },
  folders: {
    summary: "List folders in the vault",
    params: ["folder=<path>", "total"],
    run: async (engine, args) => {
      const folders = await engine.folders({ folder: args.get("folder") });
      return args.flag("total") ? String(folders.length) : lines(folders.map((folder) => folder || "/"));
    },
  },
  search: {
    summary: "Search vault for text",
    params: ["query=<text>", "path=<folder>", "limit=<n>", "total", "case", "format=text|json"],
    run: async (engine, args) => {
      const matches = await search(engine, args);
      if (args.flag("total")) return String(matches.length);
      if (matches.length === 0) return "No matches found.";
      if (args.format(["text", "json"] as const, "text") === "json")
        return JSON.stringify(matches.map((match) => match.path));
      return lines(matches.map((match) => match.path));
    },
  },
  "search:context": {
    summary: "Search with matching line context",
    params: ["query=<text>", "path=<folder>", "limit=<n>", "case", "format=text|json"],
    run: async (engine, args) => {
      const matches = await search(engine, args);
      if (matches.length === 0) return "No matches found.";
      if (args.format(["text", "json"] as const, "text") === "json") {
        return JSON.stringify(matches.map((match) => ({ file: match.path, matches: match.lines })));
      }
      return lines(
        matches.flatMap((match) =>
          match.lines.length === 0
            ? [match.path]
            : match.lines.map((line) => `${match.path}:${line.line}: ${line.text}`),
        ),
      );
    },
  },
  wordcount: {
    summary: "Count words and characters",
    params: ["file=<name>", "path=<path>", "words", "characters"],
    run: async (engine, args) => {
      const counts = await engine.wordcount(args.ref());
      if (args.flag("words")) return String(counts.words);
      if (args.flag("characters")) return String(counts.characters);
      return lines([`words: ${counts.words}`, `characters: ${counts.characters}`]);
    },
  },
  vault: {
    summary: "Show vault info",
    params: ["info=name|path|files|folders|size"],
    run: async (engine, args) => {
      const info = await engine.info();
      const key = args.get("info");
      if (key !== undefined) {
        if (!(key in info)) throw new BackroomError("invalid_argument", `Unknown info "${key}".`);
        return String(info[key as keyof typeof info]);
      }
      return tsv(Object.entries(info));
    },
  },
  create: {
    summary: "Create a new file",
    params: ["name=<name>", "path=<path>", "content=<text>", "overwrite", "version=<version>"],
    run: async (engine, args) => {
      const path = args.get("path");
      const name = args.get("name");
      if (path === undefined && name === undefined)
        throw new BackroomError("invalid_argument", "Missing required parameter: path or name.");
      if (args.get("template") !== undefined)
        throw new BackroomError("unsupported", "Templates are not supported by backroom.");
      const target: FileTarget = path !== undefined ? { path } : { name: name! };
      const result = await engine.create({
        target,
        content: args.content("content") ?? "",
        overwrite: args.flag("overwrite"),
        version: args.get("version"),
      });
      return reported(result);
    },
  },
  append: {
    summary: "Append content to a file",
    params: ["file=<name>", "path=<path>", "content=<text>", "inline", "version=<version>"],
    run: async (engine, args) => {
      const content = args.content("content") ?? args.required("content");
      return reported(
        await engine.append(args.ref(), content, { inline: args.flag("inline"), version: args.get("version") }),
      );
    },
  },
  prepend: {
    summary: "Prepend content to a file, after its frontmatter",
    params: ["file=<name>", "path=<path>", "content=<text>", "inline", "version=<version>"],
    run: async (engine, args) => {
      const content = args.content("content") ?? args.required("content");
      return reported(
        await engine.prepend(args.ref(), content, { inline: args.flag("inline"), version: args.get("version") }),
      );
    },
  },
  edit: {
    summary: "Replace an exact piece of text in a file (backroom only)",
    params: ["file=<name>", "path=<path>", "old=<text>", "new=<text>", "all", "version=<version>"],
    run: async (engine, args) => {
      const oldText = args.content("old") ?? args.required("old");
      const newText = args.content("new") ?? args.required("new");
      return reported(
        await engine.edit(args.ref(), oldText, newText, { all: args.flag("all"), version: args.get("version") }),
      );
    },
  },
  delete: {
    summary: "Move a file to the vault's .trash folder",
    params: ["file=<name>", "path=<path>", "version=<version>"],
    run: async (engine, args) => {
      if (args.flag("permanent")) {
        throw new BackroomError(
          "unsupported",
          "backroom never deletes permanently. Files go to .trash and stay in git history.",
        );
      }
      return reported(await engine.delete(args.ref(), { version: args.get("version") }));
    },
  },
  rename: {
    summary: "Rename a file and update links to it",
    params: ["file=<name>", "path=<path>", "name=<name>"],
    run: async (engine, args) => reported(await engine.rename(args.ref(), args.required("name"))),
  },
  move: {
    summary: "Move or rename a file and update links to it",
    params: ["file=<name>", "path=<path>", "to=<path>"],
    run: async (engine, args) => reported(await engine.move(args.ref(), args.required("to"))),
  },
  "git:status": {
    summary: "Show the git status of the vault and whether sync is running (backroom only)",
    params: [],
    run: async (engine) => engine.requireGit().status(),
  },
  "git:log": {
    summary: "List recent commits, optionally for one file (backroom only)",
    params: ["limit=<n>", "path=<path>"],
    run: async (engine, args) => {
      const limit = Number(args.get("limit") ?? "20");
      if (!Number.isInteger(limit) || limit < 1) throw new BackroomError("invalid_argument", "Invalid limit.");
      return engine.requireGit().log({ limit, path: args.get("path") });
    },
  },
  "git:show": {
    summary: "Show what a commit changed (backroom only)",
    params: ["commit=<id>"],
    run: async (engine, args) => engine.requireGit().show(args.required("commit")),
  },
  "git:revert": {
    summary: "Undo a commit backroom made, as a new commit (backroom only)",
    params: ["commit=<id>"],
    run: async (engine, args) => reported(await engine.revert(args.required("commit"))),
  },
};

/**
 * Draws headings as a tree like the Obsidian CLI: each heading sits below the closest heading before it with a
 * lower level, whatever the levels in between.
 */
function outlineTree(headings: OutlineHeading[]): string {
  type Node = { heading: string; children: Node[] };
  const roots: Node[] = [];
  const open: { level: number; node: Node }[] = [];
  for (const { level, heading } of headings) {
    while (open.length > 0 && open[open.length - 1]!.level >= level) open.pop();
    const node: Node = { heading, children: [] };
    (open.length > 0 ? open[open.length - 1]!.node.children : roots).push(node);
    open.push({ level, node });
  }
  const rows: string[] = [];
  const draw = (nodes: Node[], indent: string) => {
    nodes.forEach((node, index) => {
      const last = index === nodes.length - 1;
      rows.push(`${indent}${last ? "└── " : "├── "}${node.heading}`);
      draw(node.children, indent + (last ? "    " : "│   "));
    });
  };
  draw(roots, "");
  return lines(rows);
}

/** A write's summary line, followed by any warnings, such as a commit that failed. */
function reported(result: WriteResult): string {
  return lines([result.summary, ...result.warnings.map((warning) => `Warning: ${warning}`)]);
}

async function search(engine: Engine, args: Args) {
  const limit = args.get("limit");
  const parsedLimit = limit === undefined ? undefined : Number(limit);
  if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
    throw new BackroomError("invalid_argument", `Invalid limit "${limit}".`);
  }
  return engine.search(args.required("query"), {
    folder: args.get("path"),
    limit: parsedLimit,
    caseSensitive: args.flag("case"),
  });
}

export function helpText(): string {
  const entries = Object.entries(commands).sort(([a], [b]) => a.localeCompare(b));
  const body = entries.flatMap(([name, command]) => [
    `  ${name.padEnd(20)}  ${command.summary}`,
    ...command.params.map((param) => `    ${param}`),
    "",
  ]);
  return lines([
    "backroom - a headless subset of the Obsidian CLI",
    "",
    "Usage: backroom <command> [key=value ...] [flag ...]",
    "       backroom mcp                 Run the MCP server on stdio",
    "",
    "The vault is the folder in BACKROOM_VAULT, or the nearest folder above the current one that has a .obsidian",
    "folder. The vault= parameter is accepted and ignored. Use \\n and \\t for newline and tab in content values.",
    "BACKROOM_GIT=commit records every write as a git commit, BACKROOM_GIT=sync also pulls and pushes.",
    "",
    "Commands:",
    ...body,
  ]).trimEnd();
}

/** The commands with their parameters, for interfaces that expose the same operations, such as the MCP server. */
export function commandSpecs(): { name: string; summary: string; params: string[] }[] {
  return Object.entries(commands)
    .map(([name, command]) => ({ name, summary: command.summary, params: command.params }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type RunOptions = {
  /** Whether `\n` and `\t` in content values mean newline and tab. True for the shell, false for MCP. */
  unescapeContent: boolean;
};

export async function runCli(
  engine: Engine,
  invocation: Invocation,
  options: RunOptions = { unescapeContent: true },
): Promise<CliResult> {
  const { command } = invocation;
  if (command === "help" || command === "--help" || command === "-h") return { output: helpText(), exitCode: 0 };
  if (command === "version" || command === "--version") return { output: "backroom 0.1.0", exitCode: 0 };
  try {
    if (command in UNSUPPORTED) {
      throw new BackroomError("unsupported", `Command "${command}" is not supported: ${UNSUPPORTED[command]}`);
    }
    const handler = commands[command];
    if (!handler)
      throw new BackroomError(
        "unsupported",
        `Command "${command}" is not supported by backroom. Run "backroom help" for the list.`,
      );
    return { output: await handler.run(engine, argsOf(invocation, options)), exitCode: 0 };
  } catch (error) {
    if (error instanceof BackroomError) return { output: `Error: ${error.message}`, exitCode: 1 };
    throw error;
  }
}

function argsOf({ params, flags }: Invocation, options: RunOptions): Args {
  const get = (name: string) => params.get(name);
  const required = (name: string) => {
    const value = params.get(name);
    if (value === undefined)
      throw new BackroomError("invalid_argument", `Missing required parameter: ${name}=<value>.`);
    return value;
  };
  return {
    get,
    required,
    content: (name) => {
      const value = params.get(name);
      if (value === undefined) return undefined;
      return options.unescapeContent ? unescapeContent(value) : value;
    },
    flag: (name) => flags.has(name),
    format: (allowed, fallback) => {
      const format = params.get("format");
      if (format === undefined) return fallback;
      if (!(allowed as readonly string[]).includes(format)) {
        throw new BackroomError("invalid_argument", `Invalid format "${format}". Use one of ${allowed.join(", ")}.`);
      }
      return format as (typeof allowed)[number];
    },
    ref: () => {
      const ref = refOf(params);
      if (!ref) throw new BackroomError("invalid_argument", "Missing required parameter: file=<name> or path=<path>.");
      return ref;
    },
    optionalRef: () => refOf(params),
  };
}

function refOf(params: Map<string, string>): FileRef | undefined {
  const path = params.get("path");
  if (path !== undefined) return { path };
  const file = params.get("file");
  if (file !== undefined) return { file };
  return undefined;
}

/** Turns `\n` and `\t` into newline and tab. `\\` stays a backslash, so `\\n` is a literal backslash and n. */
export function unescapeContent(value: string): string {
  return value.replace(/\\(\\|n|t)/g, (_, char: string) => (char === "n" ? "\n" : char === "t" ? "\t" : "\\"));
}

function scalarText(value: JsonValue): string {
  if (value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function lines(values: string[]): string {
  return values.join("\n");
}

function tsv(rows: (string | number)[][]): string {
  return rows.map((row) => row.join("\t")).join("\n");
}

function csv(rows: (string | number)[][]): string {
  const cell = (value: string | number) => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => row.map(cell).join(",")).join("\n");
}

/** Indented json. Search results are the exception: the Obsidian CLI prints them on one line. */
function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
