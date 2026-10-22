# 9. MCP tools designed for agents

- Status: Proposed
- Date: 2026-10-22

## Context

ADR 5 makes every MCP tool a copy of an Obsidian CLI command: the same name, the same parameters as optional strings
and the same text output. That gave 32 tools whose descriptions read like a man page. Claude, asked to review the
server after using it from claude.ai, found:

- A description such as "Same as the Obsidian CLI command X" does not say when to use a tool, or which of two similar
  tools fits, such as `search` and `search_context`, or `file` and `files`.
- `file=<name>` and `path=<path>` name a note in two ways, and nothing says how they differ or which wins.
- `version` on writes is undocumented, `limit` is a string, and it caps notes, not lines, without saying so.
- Property and tag queries such as `[status:open]` already work in `search`, but the model did not know, and asked for
  a tool to query by property.
- Several tools overlap (`move` and `rename`, `tag` and `tags`, `append` and `prepend`), and four only serve vault
  hygiene (`unresolved`, `orphans`, `deadends`, `wordcount`).
- Tasks the model wants often need several calls: reading several notes, reading one section of a note, finding the
  notes changed recently, adding a line under a heading.
- Times are epoch milliseconds and `git_status` answers `sync: sync`.
- The model has to explore the vault to learn its conventions, such as how monthly notes are named.

The CLI has other users: people in a shell, and skills written against the Obsidian CLI. For them, compatibility with
the Obsidian CLI (ADR 1) still matters.

## Decision

The MCP server gets its own set of tools, designed for agents. The CLI stays compatible with the Obsidian CLI. Both
remain thin layers over the same engine operations (ADR 5), so the write rules of ADR 2 are still enforced in one
place. This replaces the rule of ADR 5 that MCP tools use the CLI's command names and parameters.

### Tools

| Tool | Does | Replaces | Annotation |
| --- | --- | --- | --- |
| `search` | Finds notes by text, property, tag or path | `search`, `search_context`, `tag` | read-only |
| `list` | Lists notes or folders, by name or by last change | `files`, `folders`, `vault` | read-only |
| `read` | Reads one or more notes, a section, and details of a note | `read`, `file`, `outline`, `properties` and `tags` and `aliases` of a note, `property_read`, `links`, `backlinks`, `wordcount` | read-only |
| `vault` | Summarizes the vault: properties, tags, aliases, and its health | `properties`, `tags` and `aliases` of the vault, `unresolved`, `orphans`, `deadends` | read-only |
| `history` | Shows the sync state, recent commits, and what a commit changed | `git_status`, `git_log`, `git_show` | read-only |
| `create` | Creates a note | `create` | write |
| `edit` | Changes a note: replaces text, appends, prepends, sets or removes properties | `append`, `prepend`, `edit`, `property_set`, `property_remove` | write |
| `move` | Moves or renames a note and updates links to it | `move`, `rename` | write |
| `delete` | Moves a note to the vault's `.trash` folder | `delete` | destructive |
| `undo` | Undoes a commit backrooms made, as a new commit | `git_revert` | destructive |

Each tool declares the MCP annotations `readOnlyHint` or `destructiveHint`, so a client can allow the read-only tools
without asking each time.

### Arguments and results

- **Naming a note.** Every tool takes a note as `note`: either its path in the vault (`Journal/2026-06 june.md`) or
  its name as a wikilink would write it (`2026-06 june`). An exact path wins. A name that matches several notes is an
  error that lists them.
- **Types.** Arguments have their real types: integers, booleans, arrays and enums, not strings.
- **Results.** Tools return JSON, declared as an output schema, rather than the CLI's text. Times are ISO 8601 with
  the vault's offset, such as `2026-10-22T09:15:00+02:00`.
- **Versions.** `read` returns each note's `version` and `modified` time. Every write accepts `version` and is
  rejected when the note changed since, which each write tool's description says in one sentence.

### Descriptions

Each description says when to use the tool, how it differs from similar ones, and what each argument means, including
limits and defaults. The description of `search` is a short reference for the query syntax with examples, and covers
property search in particular, since the model cannot discover it:

- `[status]` finds notes that have a property whose name contains `status`. `[status:open]` finds notes where one of
  its values contains `open`, one list item at a time.
- `[due:>2026-10-01]` and `[due:<2026-11]` compare the value as text, or as a number when it holds a number, so ISO
  dates compare correctly. There is no `>=`.
- `tag:#project` finds a tag and its nested tags. `path:Journal`, `file:june`, `line:(a b)` and `section:(a b)`
  narrow where terms match. Words combine with AND, `OR` and parentheses group, `-` negates, `"..."` is a phrase and
  `/.../` a regular expression.
- Examples: `[status:open] tag:#project`, `path:Journal [mood:good]`, `[date_created:>2026-10-15] -tag:#archive`.

### `search`

`search { query, folder?, limit?, context? }`. `limit` is the maximum number of notes, not of matching lines.
`context: "lines"` adds the matching lines with their numbers, which replaces `search_context`. Each note in the result
has its `modified` time.

### `list`

`list { kind: "notes" | "folders", folder?, sort: "name" | "modified", limit? }`. Sorting by `modified` answers which
notes changed recently in one call.

### `read`

`read { notes, section?, include? }` reads one or more notes in one call.

- `include` selects what is returned for each note: `content`, `outline`, `properties`, `links`, `backlinks`. The
  default is the content and the properties. `version` and `modified` are always returned.
- `section` returns the text under a heading, up to the next heading of the same or a higher level. It takes the
  heading's text, or a path of headings such as `June > 2026-06-23` when several headings have the same text. A
  heading that matches several sections is an error that lists each match as a heading path with its line number, so
  the next call can name the right one.

### `edit`

`edit { note, version?, changes }` applies a list of changes in order, each to the result of the one before. Either
all of them apply, as one write and one commit, or none do.

- `replace { old, new, all? }` works like the edit tools agents already know: `old` has to occur exactly once, unless
  `all` is true. Otherwise the call fails and says how often and at which lines it occurs, so the model can add
  surrounding text.
- `append` and `prepend` add text to the end or the start of the note, after its frontmatter. They need no anchor,
  which suits logs and inbox notes.
- `append_to_section { heading, content }` adds text at the end of a section, the most common write to a journal or
  project note. Text goes before the section's subsections; content that starts with a heading is a new subsection
  and goes after the last one. `heading` names the section like `read`'s `section` does, and a heading that matches
  several sections fails and lists them, so the change never lands in the wrong one.
- `set_content { content }` replaces everything after the frontmatter, to restructure a note in one change that keeps
  its history, instead of many replacements or a delete and a create. The properties stay, and content that starts
  with frontmatter is refused, so properties only change through `set_property`.
- `set_property { name, value, type? }` and `remove_property { name }` change the frontmatter through the engine, so
  its formatting stays as it is (ADR 2) and plugin rules such as the Linter's timestamps apply (ADR 7).

Changes are anchored on exact text, or on a heading that matches exactly one section. Headings repeat in a vault,
and a change that lands in the wrong section damages a note while a read of the wrong section does not, so a heading
that is not unique fails instead of picking one.

### `move` and `delete`

`move` creates the destination folder when it does not exist. `delete` leaves links to the note as they are.

### `vault` and `history`

- `vault { report }` with `report` one of `properties`, `tags`, `aliases` or `health`. `health` lists unresolved links,
  orphans and dead ends together.
- `history { note?, commit?, limit? }` without arguments returns the sync state in words and the latest commits, such
  as "sync on, last pull 2 minutes ago, last push 5 minutes ago, nothing uncommitted". With `note` it lists the
  note's commits, and with `commit` it shows what the commit changed.

### Server instructions

The MCP server sends instructions in two parts:

- Fixed text on how the tools work together: find notes with `search` or `list`, read them with `read`, change them
  with `edit` and the `version` from `read`.
- The vault's own conventions, from the note `AGENTS.md` at the vault root when it exists, such as how notes are named
  and in which languages they are written. The vault's owner changes them in Obsidian, without redeploying backrooms.
  The note is read when a client connects, so a change applies to the next connection.

### The CLI

The CLI stays compatible with the Obsidian CLI for now. If the CLI should later follow the MCP tools, so that
`backrooms move` takes the same arguments as the `move` tool, the Obsidian-compatible commands move to
`backrooms obsidian <command>`. That change needs its own decision.

### Not decided here

- **Semantic search** over the vault would complement literal search, for example as `search { mode: "semantic" }`,
  but adds an index and embeddings to the server.
- **Requiring `version`** for writes that can lose text, such as `replace`, `set_content`, `move` and `delete`, so the
  concurrency check is not opt-in.
- **Creating a note from a template** needs the syntax of Obsidian's Templates plugin, which falls under ADR 7.

## Consequences

- An agent sees 10 tools instead of 32, with descriptions it can choose from, and needs fewer calls for common tasks.
- The CLI and the MCP tools no longer share names and arguments. Each MCP tool needs tests that call it through MCP,
  and ADR 5's consequence that every operation can be tried from the shell holds only until the CLI follows the tools.
- The second-brain skill, written against the Obsidian CLI, needs a separate way of working when it uses backrooms
  remotely through MCP.
- New engine operations are needed: reading a section, `edit` as one atomic write of several changes, listing by last
  change, and the sync state in words.
- Clients that already connected see the new tools after reconnecting. Nothing else depends on the old tool names yet.
