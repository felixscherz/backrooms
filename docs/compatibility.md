# Compatibility with the Obsidian CLI

What backroom implements, and how well each behavior is pinned to Obsidian. ADR 1 asks for every behavior to be checked
against the real Obsidian app before it ships. That has not happened yet for most of them: when the first version was
built, the Obsidian app on the laptop was stuck behind a dialog and its CLI did not answer.

The evidence used instead:

- **Recorded**: output of the real Obsidian CLI (1.13.7, installer 1.12.7) on the personal vault, found in earlier
  agent sessions. Formats marked this way match that output.
- **Help**: the parameter list of `obsidian help`. Parameters match, output is assumed.
- **Assumed**: backroom's best guess. Needs checking against Obsidian.

## Commands

| Command | Evidence | Notes |
| --- | --- | --- |
| `read` | Assumed | Prints the file as stored. |
| `file` | Assumed | `key<TAB>value` lines. Adds `version`, which Obsidian does not have. |
| `outline` | Assumed | `format=json` gives `{level, heading, line}` with 1-based lines. Tree output indents by 2 spaces per level. |
| `properties` | Assumed | With a file: the frontmatter as written (yaml), the parsed object (json) or `name<TAB>value` (tsv). Without: property names, `counts` adds counts. |
| `property:read` | Assumed | Lists print one item per line. |
| `property:set` | Recorded | `Set <name>: <value>` and the datetime error message are recorded. Writing lists in block style and taking the type from `.obsidian/types.json`, then from the current value, when `type` is missing are assumed. backroom edits the YAML in place, where Obsidian may reformat the frontmatter. |
| `property:remove` | Assumed | |
| `tags` | Recorded | json `[{"tag": "#x", "count": "3"}]` with counts as strings. The vault listing includes parent tags and leaves out excluded files. That a parent counts once per nested tag below it is inferred from the recorded counts. |
| `tag` | Recorded | `#tag<TAB>count`, then the files with `verbose`. Includes notes with nested tags (assumed). |
| `aliases` | Assumed | `verbose` gives `alias<TAB>path`. |
| `links` | Recorded | Sorted, one per target, unresolved ones as `Name (unresolved)`. That embeds count as links is assumed. |
| `backlinks` | Recorded | `No backlinks found.` when empty. json `[{"file": "...", "count": "1"}]`. Links from properties count. |
| `unresolved` | Recorded | json `[{"link", "count", "sources"}]` with counts as strings and sources joined by `, `. |
| `orphans`, `deadends` | Help | `orphans` counts links from other notes only. |
| `files`, `folders` | Help | Hidden folders are not part of the vault. |
| `search` | Recorded | One path per line, `No matches found.` when empty. Matches content and file path. |
| `search:context` | Assumed | Text output is `path:line: text`. json `[{"file", "matches": [{"line", "text"}]}]` with 1-based lines. |
| `wordcount`, `vault` | Assumed | |
| `create` | Recorded | `Created: <path>`. Refuses to replace a file, `overwrite` needs `version=`. Creates missing folders. `template=` is not supported. |
| `append`, `prepend` | Assumed | Content goes on its own line unless `inline`. `prepend` inserts after the frontmatter. Output `Appended to: <path>` is assumed. |
| `delete` | Recorded | `Moved to trash: <path>`, always into `.trash/`. `permanent` is not supported. |
| `rename` | Recorded | `Renamed: <old> -> <new>`. A name without extension keeps the old one. |
| `move` | Assumed | `Moved: <old> -> <new>`. A destination ending in `/`, an existing folder or a path without extension is a folder. |

Commands that need the app (`open`, `command`, `search:open`, `tab:open`, `random`) report that they are unsupported.
Everything else the Obsidian CLI offers, such as bookmarks, bases, tasks, plugins or sync history, reports an unknown
command.

## Vault behavior

| Behavior | Evidence | Notes |
| --- | --- | --- |
| Link resolution | Assumed | Exact path, then relative to the linking note, then by name; ties go to the linking note's folder, then the shortest path. Case is ignored. Aliases do not resolve links. |
| Link updates on rename and move | Assumed | Every link to the moved file is written anew with the vault's `newLinkFormat`, keeping subpath, display text and the link's syntax. Other links are only rewritten if the move would change where they point. |
| Tags | Assumed | Inline tags after whitespace, at least one non-digit, not in code or `%%` comments, plus the `tags` property. Case-insensitive, once per note. |
| Frontmatter | Assumed | Only at the very start of the file, closed by `---`. Invalid YAML gives no properties, and backroom refuses to change properties of such a note. |
| Excluded files | Recorded | `userIgnoreFilters` hide files from `tags`, `tag` and search. Prefixes and `/regex/` are supported. Links from excluded files still count. |
| Sort order | Recorded | Listings sort by code units (`AWS Glue Table.md` before `Amazon Athena.md`). Obsidian's search order is not reproducible from file names or times, so search results use the same order. |
| Search syntax | Assumed | Words, `"phrases"`, `OR`, `-`, parentheses, `/regex/`, `file:`, `path:`, `content:`, `line:`, `tag:`, `[property]` and `[property:value]`. Other operators are reported as unsupported. |

## Checking against Obsidian

To pin a behavior, open a small vault in Obsidian, run the same command through `obsidian` and `backroom`, and compare.
The test vaults in `src/*.test.ts` are a starting point. When they agree, change the evidence above to the Obsidian
version it was checked against.
