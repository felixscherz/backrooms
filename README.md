# backroom

A headless server for an Obsidian vault. backroom works on a git clone of the vault and implements a subset of the
Obsidian CLI without the Obsidian app, so agents can read, search and edit the vault from anywhere, for example from the
Claude app on a phone through MCP.

- [docs/vision.md](docs/vision.md) explains why backroom exists and what it is for.
- [docs/obsidian-cli-coverage.md](docs/obsidian-cli-coverage.md) lists the Obsidian CLI features backroom needs.
- [docs/compatibility.md](docs/compatibility.md) says which commands backroom implements, how they are checked against
  Obsidian, and where backroom deliberately differs.
- [docs/adr/](docs/adr/) holds the architecture decisions.

## Usage

backroom takes the same commands and `key=value` parameters as the Obsidian CLI:

```bash
cd ~/notes                      # or: export BACKROOM_VAULT=~/notes
backroom search query="pizza"
backroom backlinks path="Note.md" format=json counts
backroom property:set path="Note.md" name=last_reviewed value=2026-10-21 type=date
backroom rename path="Old.md" name="New"
backroom help                   # every command with its parameters
```

The vault is the folder in `BACKROOM_VAULT`, or the nearest folder at or above the current one that contains a
`.obsidian` folder. `vault=<name>` is accepted and ignored, since backroom serves one vault.

Commands that only make sense with the app running, such as `open` or `command`, fail with an error that says they are
not supported.

### Commands backroom adds

- `edit path=<path> old=<text> new=<text> [all]` replaces an exact piece of text. The text has to occur exactly once
  unless `all` is set. A remote agent cannot edit files itself, so this replaces the file edits the `second-brain`
  skill makes on the laptop.
- `file path=<path>` prints a `version`. Pass it as `version=<version>` to `edit`, `append`, `prepend`, `delete` or
  `create ... overwrite` and the write is rejected if the file changed since. `create ... overwrite` requires it.
- `git:status`, `git:log [limit=<n>] [path=<path>]`, `git:show commit=<id>` and `git:revert commit=<id>` let an agent
  look at and undo what backroom changed.

### Writes

Every write goes through one write path (ADR 2): only the intended bytes change, each file is replaced atomically,
multi-file changes such as a rename roll back if they fail part way, deleted notes go to `.trash/`, and backroom never
touches `.obsidian/` or other hidden folders. A rename or move that would make any link point at a different file is
rejected. A write that fails says whether the vault was left unchanged or names the files it could not restore.

Several backroom processes on one vault, such as the MCP server and a CLI run, take turns: a write holds a lock file in
`.git/`, or in the system's temporary folder when the vault is not a git repository, while it runs. A lock left by a process that ended is taken over, and a write gives up
with a `busy` error after waiting 10 seconds for a lock that a running process holds.

### Plugins

backroom reimplements some features of community plugins and applies them when the vault enables the plugin, with the
plugin's own settings from `.obsidian/plugins/<id>/data.json` (ADR 7). A note is linted when a command creates or
changes it, not when it is only renamed, moved or deleted. Like the Linter, backroom only lints when the Linter lints on
save or on leaving a note, or updates timestamps as a note changes, and leaves the folders and files it ignores alone.

| Plugin | What backroom does |
| --- | --- |
| Linter (`obsidian-linter`) | The `yaml-timestamp` rule: records when a note was created and last modified in its frontmatter |

Timestamps are written in the local time of the process, so set `TZ` on a server. A note without a creation date gets
the date git first saw it, or the file system's date outside git. When the Linter's settings ask for something backroom
cannot do the same way, such as a date format with month names, writes fail with an error.

### Git

| `BACKROOM_GIT` | Behavior |
| --- | --- |
| `off` (default) | backroom does not touch git. `git:status`, `git:log` and `git:show` still work in a repository. |
| `commit` | Every write becomes one commit of exactly the files it touched. |
| `sync` | Also fetches and rebases before each write and every minute in the MCP server, and pushes after each commit. |

`BACKROOM_PULL_INTERVAL` sets how many seconds the MCP server waits between pulls in `sync` mode (default 60).

A rebase that conflicts is aborted. backroom keeps its local commits, stops syncing and reports it in `git:status` and
as a warning after each write, until a human resolves it.

### MCP

`backroom mcp` serves every command as an MCP tool over stdio. Tool names replace `:` with `_` (`search_context`),
parameters are named arguments, flags are booleans, and the result is the text the CLI prints. Content is taken
literally, without the `\n` escapes the shell needs.

```json
{
  "mcpServers": {
    "backroom": { "command": "backroom", "args": ["mcp"], "env": { "BACKROOM_VAULT": "/srv/notes" } }
  }
}
```

The streamable HTTP transport for remote clients is not implemented yet, because authentication is still an open
question (ADR 5).

## Development

backroom is written in TypeScript and runs on [Bun](https://bun.com).

```bash
bun install
bun test
bun run typecheck
bun run format
bun run build                   # single executable in dist/backroom
```

The tests drive the CLI against temporary vaults on disk, and the git tests use real repositories with a bare remote.
`compat/compat.test.ts` checks that backroom answers like the Obsidian CLI on [test-vault/](test-vault/), against
answers recorded with `bun compat/record.ts` (see [docs/compatibility.md](docs/compatibility.md)).
`compat/linter.test.ts` does the same for the Linter plugin on `compat/linter-vault/`, recorded with
`bun compat/record-linter.ts`.
