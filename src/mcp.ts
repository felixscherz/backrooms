import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isoDateTime } from "./date-format";
import type { Engine, NoteDetail, WriteResult } from "./engine";
import { BackroomsError } from "./errors";
import { propertyValueTypes, type PropertyValueType } from "./frontmatter";
import type { SyncState } from "./git";

/**
 * The MCP server's tools, designed for agents rather than copied from the CLI (ADR 9): few tools, typed arguments,
 * JSON results, and descriptions that say when to use each. Like the CLI, they only translate arguments and results
 * for the engine, which enforces the write rules.
 */
export async function createMcpServer(engine: Engine): Promise<McpServer> {
  const server = new McpServer(
    { name: "backrooms", version: "0.1.0" },
    { instructions: await serverInstructions(engine) },
  );
  const time = (ms: number | Date) => isoDateTime(new Date(ms), engine.clock.timeZone);

  server.registerTool(
    "search",
    {
      title: "Search notes",
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        query: z.string().describe("The query, in Obsidian's search syntax. See the tool description."),
        folder: z.string().optional().describe("Only search notes in this folder and its subfolders."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(20)
          .describe("The maximum number of notes returned, not of matching lines. Default 20."),
        context: z
          .enum(["none", "lines"])
          .default("none")
          .describe('"lines" adds the lines of each note that match, with their line numbers. Default "none".'),
        case_sensitive: z.boolean().default(false).describe("Match the case of the words. Default false."),
      },
      outputSchema: {
        notes: z.array(
          z.object({
            path: z.string(),
            modified: z.string(),
            lines: z.array(z.object({ line: z.number(), text: z.string() })).optional(),
          }),
        ),
        more: z.boolean().describe("Whether more notes match than the limit returned."),
      },
      annotations: READ_ONLY,
    },
    ({ query, folder, limit, context, case_sensitive }) =>
      result(async () => {
        const matches = await engine.search(query, { folder, limit: limit + 1, caseSensitive: case_sensitive });
        return {
          notes: matches.slice(0, limit).map((match) => ({
            path: match.path,
            modified: time(match.modified),
            ...(context === "lines" ? { lines: match.lines } : {}),
          })),
          more: matches.length > limit,
        };
      }),
  );

  server.registerTool(
    "list",
    {
      title: "List notes or folders",
      description:
        "Lists the notes or the folders of the vault, or of one folder and its subfolders. Use it to browse the " +
        'vault\'s structure, or with sort "modified" to find the notes that changed most recently, such as what ' +
        "was written today. To find notes by their content, properties or tags, use search instead.",
      inputSchema: {
        kind: z.enum(["notes", "folders"]).default("notes").describe('What to list. Default "notes".'),
        folder: z.string().optional().describe("Only list what is in this folder and its subfolders."),
        sort: z
          .enum(["name", "modified"])
          .default("name")
          .describe(
            '"name" sorts by path, "modified" lists the most recently changed notes first. Folders are always sorted by name.',
          ),
        limit: z.number().int().min(1).max(1000).default(100).describe("The maximum number of entries. Default 100."),
      },
      outputSchema: {
        items: z.array(z.object({ path: z.string(), modified: z.string().optional() })),
        total: z.number().describe("How many entries there are in all, before the limit."),
      },
      annotations: READ_ONLY,
    },
    ({ kind, folder, sort, limit }) =>
      result(async () => {
        if (kind === "folders") {
          const folders = (await engine.folders({ folder })).filter((path) => path !== "");
          return { items: folders.slice(0, limit).map((path) => ({ path })), total: folders.length };
        }
        const notes = await engine.files({ folder, ext: "md", sort });
        return {
          items: notes.slice(0, limit).map((note) => ({ path: note.path, modified: time(note.modified) })),
          total: notes.length,
        };
      }),
  );

  server.registerTool(
    "read",
    {
      title: "Read notes",
      description:
        "Reads one or more notes in one call, or one section of them. Returns each note's version and when it " +
        "was last modified; pass the version to edit, move or delete so the write fails if the note changed since. " +
        "A note that cannot be read gets an error in its entry, and the other notes are still returned.\n\n" +
        'include selects what else to return for each note: "content" (the markdown, including frontmatter), ' +
        '"properties" (the frontmatter as JSON), "outline" (headings with level and line), "links" (the notes ' +
        'it links to, and links that resolve to no note) and "backlinks" (the notes linking to it, with counts). ' +
        'The default is ["content", "properties"].\n\n' +
        "section returns the text under one heading, from the heading line to the next heading of the same or a " +
        "higher level, instead of the whole note. Give the heading's text, or a path of headings such as " +
        '"June > 2026-06-23" when several headings have the same text. If it matches several headings, the error ' +
        "lists each as a heading path with its line number. To add a line under a heading, read the section and " +
        "then use edit with a replace anchored on its text.",
      inputSchema: {
        notes: z
          .union([z.string(), z.array(z.string()).min(1)])
          .describe(`${NOTE_ARGUMENT} Give a list to read several notes at once.`),
        section: z.string().optional().describe("Only read the section under this heading."),
        include: z
          .array(z.enum(NOTE_DETAILS))
          .default(["content", "properties"])
          .describe('What to return besides version and modified. Default ["content", "properties"].'),
      },
      outputSchema: {
        notes: z.array(
          z.object({
            note: z.string().describe("The note as it was named in the call."),
            path: z.string().optional(),
            version: z.string().optional(),
            modified: z.string().optional(),
            content: z.string().optional(),
            section: z.object({ heading: z.string(), line: z.number() }).optional(),
            properties: z.record(z.string(), z.unknown()).optional(),
            outline: z.array(z.object({ level: z.number(), heading: z.string(), line: z.number() })).optional(),
            links: z.array(z.object({ target: z.string(), resolved: z.boolean() })).optional(),
            backlinks: z.array(z.object({ note: z.string(), count: z.number() })).optional(),
            error: z.string().optional(),
          }),
        ),
      },
      annotations: READ_ONLY,
    },
    ({ notes, section, include }) =>
      result(async () => {
        const names = typeof notes === "string" ? [notes] : notes;
        const readings = await engine.readNotes(
          names.map((note) => ({ note })),
          { section, include: new Set(include) },
        );
        return {
          notes: readings.map((reading, index) => {
            const note = names[index]!;
            if ("error" in reading) return { note, error: reading.error.message };
            const { modified, backlinks, ...rest } = reading;
            return {
              note,
              ...rest,
              modified: time(modified),
              ...(backlinks ? { backlinks: backlinks.map(({ file, count }) => ({ note: file, count })) } : {}),
            };
          }),
        };
      }),
  );

  server.registerTool(
    "vault",
    {
      title: "Summarize the vault",
      description:
        "Summarizes the whole vault. Use it to learn which properties and tags the vault uses before searching " +
        'or setting them. report "properties" lists each property with its type and how many notes have it, ' +
        '"tags" each tag with how often it occurs (a parent such as #project counts its nested tags), "aliases" ' +
        'each alias with its note, and "health" the links that resolve to no note, the files no note links to ' +
        "(orphans) and the notes that link to nothing (dead ends).",
      inputSchema: {
        report: z.enum(["properties", "tags", "aliases", "health"]).describe("Which summary to return."),
      },
      outputSchema: {
        properties: z.array(z.object({ name: z.string(), type: z.string(), count: z.number() })).optional(),
        tags: z.array(z.object({ tag: z.string(), count: z.number() })).optional(),
        aliases: z.array(z.object({ alias: z.string(), note: z.string() })).optional(),
        health: z
          .object({
            unresolved: z.array(z.object({ link: z.string(), count: z.number(), sources: z.array(z.string()) })),
            orphans: z.array(z.string()),
            deadends: z.array(z.string()),
          })
          .optional(),
      },
      annotations: READ_ONLY,
    },
    ({ report }) =>
      result(async () => {
        switch (report) {
          case "properties":
            return { properties: await engine.propertyNames() };
          case "tags":
            return { tags: (await engine.tags()).map(({ tag, count }) => ({ tag: `#${tag}`, count })) };
          case "aliases":
            return { aliases: (await engine.aliases()).map(({ alias, path }) => ({ alias, note: path })) };
          case "health": {
            const notes = new Set((await engine.files({ ext: "md" })).map((note) => note.path));
            return {
              health: {
                unresolved: await engine.unresolved(),
                orphans: await engine.orphans(),
                // Attachments link to nothing by nature, so only notes count as dead ends here.
                deadends: (await engine.deadends()).filter((path) => notes.has(path)),
              },
            };
          }
        }
      }),
  );

  server.registerTool(
    "history",
    {
      title: "Show history and sync state",
      description:
        "Shows the vault's git history. Every write through backrooms is one commit. Without arguments, it " +
        "returns the sync state in words (whether sync is on, when it last pulled and pushed, what is not " +
        "committed) and the latest commits. With note, it lists the commits that changed that note. With commit, " +
        "it shows what that commit changed, as a list of files and a patch. Use undo to revert a commit.",
      inputSchema: {
        note: z.string().optional().describe(`Only list the commits that changed this note. ${NOTE_ARGUMENT}`),
        commit: z.string().optional().describe("Show what this commit changed, by its id from the list of commits."),
        limit: z.number().int().min(1).max(100).default(10).describe("The maximum number of commits. Default 10."),
      },
      outputSchema: {
        sync: z.string().optional().describe("The sync state in words."),
        commits: z.array(COMMIT).optional(),
        commit: COMMIT.extend({
          files: z.array(z.object({ path: z.string(), status: z.string() })),
          patch: z.string(),
        }).optional(),
      },
      annotations: READ_ONLY,
    },
    ({ note, commit, limit }) =>
      result(async () => {
        if (note !== undefined && commit !== undefined) {
          throw new BackroomsError("invalid_argument", "Give a note or a commit, not both.");
        }
        const git = engine.git;
        if (!git) {
          if (note === undefined && commit === undefined) {
            return { sync: "The vault is not a git repository, so there is no history.", commits: [] };
          }
          throw new BackroomsError("unsupported", "The vault is not a git repository, so there is no history.");
        }
        if (commit !== undefined) {
          const details = await git.commitDetails(commit);
          return { commit: { ...details, time: time(details.time) } };
        }
        const path = note === undefined ? undefined : await notePath(engine, note);
        const commits = (await git.commits({ limit, path })).map((entry) => ({ ...entry, time: time(entry.time) }));
        if (note !== undefined) return { commits };
        return { sync: describeSync(await git.syncState(), engine.clock.now()), commits };
      }),
  );

  server.registerTool(
    "create",
    {
      title: "Create a note",
      description:
        "Creates a new markdown note. Fails if the note already exists; use edit to change an existing note. " +
        'Give a path such as "Projects/Pizza oven.md" to place it in a folder, or a bare name such as ' +
        '"Pizza oven" to place it where the vault puts new notes. ".md" is added when missing. Content may ' +
        "start with frontmatter. Returns the note's path and version.",
      inputSchema: {
        note: z.string().describe("The path or name of the new note."),
        content: z.string().default("").describe("The note's markdown. Default empty."),
      },
      outputSchema: WRITE_OUTPUT,
      annotations: WRITES,
    },
    ({ note, content }) =>
      result(async () =>
        written(
          await engine.create({
            target: note.includes("/") ? { path: note } : { name: note },
            content,
            failIfExists: true,
          }),
        ),
      ),
  );

  server.registerTool(
    "edit",
    {
      title: "Edit a note",
      description:
        "Changes an existing note. changes is a list applied in order, each to the result of the one before; " +
        "either all apply, as one write and one commit, or none do and the error names the change that failed. " +
        `${VERSION_SENTENCE}\n\n` +
        'Changes, each an object with "op":\n' +
        '- {op: "replace", old, new, all?}: replaces the exact text old with new. old has to occur exactly once, ' +
        "unless all is true; otherwise the call fails and says at which lines it occurs, so you can include more " +
        "surrounding text. To add a line under a heading, read the section and replace its last line with that " +
        "line plus the new one.\n" +
        '- {op: "append", content}: adds content at the end of the note, on a new line. Suits logs and inboxes.\n' +
        '- {op: "prepend", content}: adds content at the start of the note, after its frontmatter.\n' +
        '- {op: "set_property", name, value, type?}: sets a frontmatter property. value is text, a number, a ' +
        `boolean or a list of text. type is one of ${propertyValueTypes.join(", ")}; without it, the type is the ` +
        "one the vault knows for the property, else the value's own. Dates are YYYY-MM-DD.\n" +
        '- {op: "remove_property", name}: removes a frontmatter property.\n\n' +
        "Properties are changed in place, so the rest of the frontmatter keeps its formatting.",
      inputSchema: {
        note: z.string().describe(NOTE_ARGUMENT),
        version: z.string().optional().describe("The version from read. The edit fails if the note changed since."),
        changes: z.array(NOTE_CHANGE).min(1).describe("The changes, applied in order."),
      },
      outputSchema: WRITE_OUTPUT,
      annotations: WRITES,
    },
    ({ note, version, changes }) => result(async () => written(await engine.editNote({ note }, changes, { version }))),
  );

  server.registerTool(
    "move",
    {
      title: "Move or rename a note",
      description:
        "Moves a note to another folder, renames it, or both, and updates every link to it in the vault. " +
        `Give folder, name or both. ${VERSION_SENTENCE}`,
      inputSchema: {
        note: z.string().describe(NOTE_ARGUMENT),
        folder: z.string().optional().describe('The folder to move the note to. "" is the vault root.'),
        name: z.string().optional().describe("The note's new name, without folder. The extension is kept."),
        version: z.string().optional().describe("The version from read. The move fails if the note changed since."),
      },
      outputSchema: WRITE_OUTPUT,
      annotations: WRITES,
    },
    ({ note, folder, name, version }) =>
      result(async () => written(await engine.relocate({ note }, { folder, name, version }))),
  );

  server.registerTool(
    "delete",
    {
      title: "Delete a note",
      description:
        "Moves a note to the vault's .trash folder, where Obsidian keeps deleted notes. Links to it are left as " +
        `they are. undo on the commit brings it back. ${VERSION_SENTENCE}`,
      inputSchema: {
        note: z.string().describe(NOTE_ARGUMENT),
        version: z.string().optional().describe("The version from read. Fails if the note changed since."),
      },
      outputSchema: WRITE_OUTPUT,
      annotations: DESTRUCTIVE,
    },
    ({ note, version }) => result(async () => written(await engine.delete({ note }, { version }))),
  );

  server.registerTool(
    "undo",
    {
      title: "Undo a commit",
      description:
        "Undoes a commit backrooms made, as a new commit, for example to take back an edit, a move or a delete. " +
        "Find the commit with history. Fails if a note the commit changed has changed since, and for commits " +
        "backrooms did not make.",
      inputSchema: { commit: z.string().describe("The commit's id, from history.") },
      outputSchema: WRITE_OUTPUT,
      annotations: DESTRUCTIVE,
    },
    ({ commit }) => result(async () => written(await engine.revert(commit))),
  );

  return server;
}

/** Serves MCP on stdio until the client closes it, pulling from the remote every `pullIntervalMs` in sync mode. */
export async function serveStdio(engine: Engine, pullIntervalMs: number = 60_000): Promise<void> {
  const server = await createMcpServer(engine);
  await server.connect(new StdioServerTransport());
  const timer = engine.git?.mode === "sync" ? setInterval(() => void engine.pull(), pullIntervalMs) : null;
  await new Promise<void>((resolve) => {
    process.stdin.on("close", resolve);
    process.stdin.on("end", resolve);
  });
  if (timer) clearInterval(timer);
  await server.close();
}

/** The note the vault's owner writes conventions for agents in, such as how notes are named. */
export const CONVENTIONS_NOTE = "AGENTS.md";

const INSTRUCTIONS = `backrooms gives access to an Obsidian vault: markdown notes with frontmatter properties, tags and \
[[wikilinks]].

- Find notes with search (by text, property, tag or path) or list (by folder, or by last change). Use vault to learn \
which properties and tags exist.
- Read notes with read, which returns each note's version. Read only a section when the note is long.
- Change notes with edit and pass the version from read, so the change fails instead of overwriting what changed \
since. Create notes with create, move or rename them with move, and delete them with delete.
- Name a note by its path, such as "Journal/2026-06 june.md", or by its name, such as "2026-06 june".
- Every write is one git commit. history shows them, and undo takes one back.`;

/**
 * Fixed text on how the tools work together, followed by the vault's own conventions from `AGENTS.md` at the vault
 * root. The note is read for every new connection, so a change in Obsidian applies to the next one. It is read from
 * disk directly, since over HTTP every request connects anew and loading the whole vault each time would be wasted.
 */
async function serverInstructions(engine: Engine): Promise<string> {
  try {
    const text = await readFile(join(engine.root, CONVENTIONS_NOTE), "utf8");
    return `${INSTRUCTIONS}\n\n## Conventions of this vault, from ${CONVENTIONS_NOTE}\n\n${text.trim()}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return INSTRUCTIONS;
    throw error;
  }
}

const NOTE_ARGUMENT =
  'A note\'s path in the vault, such as "Journal/2026-06 june.md", or its name as a wikilink writes it, such as ' +
  '"2026-06 june". A path wins; a name that matches several notes is an error that lists them.';

const VERSION_SENTENCE =
  "Pass the version from read, and the write is rejected if the note changed since, so read it again then.";

const NOTE_DETAILS = ["content", "properties", "outline", "links", "backlinks"] as const satisfies NoteDetail[];

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const COMMIT = z.object({ id: z.string(), time: z.string(), author: z.string(), message: z.string() });

const WRITE_OUTPUT = {
  summary: z.string(),
  path: z.string().optional().describe("Where the note is after the write."),
  version: z.string().optional().describe("The note's version after the write, for the next write."),
  warnings: z.array(z.string()).describe("Problems that did not stop the write, such as a failed push."),
};

const NOTE_CHANGE = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("replace"),
    old: z.string().describe("The exact text to replace."),
    new: z.string().describe("The text to put in its place."),
    all: z.boolean().optional().describe("Replace every occurrence instead of requiring exactly one."),
  }),
  z.object({ op: z.literal("append"), content: z.string() }),
  z.object({ op: z.literal("prepend"), content: z.string() }),
  z.object({
    op: z.literal("set_property"),
    name: z.string(),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
    type: z.enum(propertyValueTypes as [PropertyValueType, ...PropertyValueType[]]).optional(),
  }),
  z.object({ op: z.literal("remove_property"), name: z.string() }),
]);

const SEARCH_DESCRIPTION = `Finds notes by text, property, tag or path, in Obsidian's search syntax. Returns the \
matching notes with when each was last modified, and with context "lines" the lines that match. Use list instead to \
browse a folder or find recently changed notes, and read to get a note's content.

Words combine with AND: \`pizza dough\` finds notes containing both. \`OR\` and parentheses group: \`(pizza OR \
bread) dough\`. \`-\` negates: \`pizza -frozen\`. \`"..."\` is a phrase and \`/.../\` a regular expression. Matching \
ignores case unless case_sensitive is set.

Properties (frontmatter):
- \`[status]\` finds notes that have a property whose name contains "status".
- \`[status:open]\` finds notes where a value of that property contains "open", checking each item of a list.
- \`[due:>2026-10-01]\` and \`[due:<2026-11]\` compare the value as text, or as a number when it holds one, so ISO \
dates compare correctly. There is no >=.
- \`[status:open OR waiting]\` and \`[status:"in progress"]\` work inside the brackets.

Narrowing where terms match:
- \`tag:#project\` finds a tag and its nested tags, such as #project/oven.
- \`path:Journal\` matches the path, \`file:june\` the file name, \`content:pizza\` only the text.
- \`line:(pizza dough)\` needs the words on one line, \`section:(pizza dough)\` under one heading.
- \`task-todo:oven\` finds open tasks mentioning oven, \`task-done:\` finished ones.

Examples: \`[status:open] tag:#project\`, \`path:Journal [mood:good]\`, \`[date_created:>2026-10-15] -tag:#archive\`.`;

/** Runs a tool and turns its result into structured content, and errors the caller can act on into tool errors. */
async function result<T extends Record<string, unknown>>(run: () => Promise<T>) {
  try {
    const structuredContent = await run();
    return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
  } catch (error) {
    if (!(error instanceof BackroomsError)) throw error;
    return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
  }
}

function written(write: WriteResult) {
  return {
    summary: write.summary,
    ...(write.note ? { path: write.note.path, version: write.note.version } : {}),
    warnings: write.warnings,
  };
}

/** The path git knows a note by. A note that no longer exists, for example after a delete, is taken as a path. */
async function notePath(engine: Engine, note: string): Promise<string> {
  try {
    return (await engine.fileInfo({ note })).path;
  } catch (error) {
    if (error instanceof BackroomsError && error.code === "not_found") return note;
    throw error;
  }
}

/** The sync state in words, such as "sync on, last pull 2 minutes ago, last push 5 minutes ago, nothing uncommitted". */
export function describeSync(state: SyncState, now: Date): string {
  const parts: string[] = [];
  switch (state.mode) {
    case "off":
      parts.push("git off, writes are not committed");
      break;
    case "commit":
      parts.push("sync off, every write is committed but not pushed");
      break;
    case "sync":
      parts.push(state.stopped ? `sync stopped until a human resolves it: ${state.stopped}` : "sync on");
      parts.push(state.lastPull ? `last pull ${ago(state.lastPull, now)}` : "no pull since backrooms started");
      parts.push(state.lastPush ? `last push ${ago(state.lastPush, now)}` : "no push since backrooms started");
      if (state.unpushed) parts.push(`${state.unpushed} ${state.unpushed === 1 ? "commit" : "commits"} not pushed`);
      break;
  }
  const uncommitted = state.uncommitted.length;
  parts.push(
    uncommitted === 0
      ? "nothing uncommitted"
      : `${uncommitted} ${uncommitted === 1 ? "file" : "files"} uncommitted: ${state.uncommitted.join(", ")}`,
  );
  return parts.join(", ");
}

function ago(then: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  const count = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"} ago`;
  if (seconds < 60) return "less than a minute ago";
  if (seconds < 3600) return count(Math.floor(seconds / 60), "minute");
  if (seconds < 86_400) return count(Math.floor(seconds / 3600), "hour");
  return count(Math.floor(seconds / 86_400), "day");
}
