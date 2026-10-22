# Compatibility with the Obsidian CLI

What backroom implements, and how it is checked against Obsidian. ADR 1 makes Obsidian's behavior the spec, so the
check is automated: backroom has to answer like the real Obsidian CLI on a test vault.

## How it is checked

[test-vault/](../test-vault/) is a small vault built to cover what tends to differ: links of every kind, nested and
case-variant tags, an excluded folder, broken frontmatter, Windows line endings, unusual property values, and notes
for word counting and sort order. It is opened in Obsidian as the vault `test-vault`.

- [compat/commands.txt](../compat/commands.txt) lists read commands and [compat/writes.txt](../compat/writes.txt)
  write commands.
- `bun compat/record.ts` runs each of them through the Obsidian CLI, stores the answers and the files each write
  changed in [compat/obsidian.json](../compat/obsidian.json), and resets the notes of test-vault with git after
  each write. It needs Obsidian running with test-vault open, and reloads the vault first.
- [compat/compat.test.ts](../compat/compat.test.ts) runs the same commands through backroom, each write on a copy of
  the vault, and expects the same output and the same file changes. It is part of `bun test`.

The recording was made with Obsidian 1.13.7 (installer 1.12.7). After an Obsidian update, record again and the test
shows what changed. To pin down a new behavior, add a note to test-vault and the command to one of the lists.

Some behaviors were also checked on a copy of the personal vault, which has about 870 files: the tag list with its
counts matches exactly, and so do the word counts of 53 notes.

## Commands

All of these match Obsidian on test-vault, with the differences listed below.

- Reading: `read`, `file`, `outline`, `properties`, `property:read`, `tags`, `tag`, `aliases`, `links`, `backlinks`,
  `unresolved`, `orphans`, `deadends`, `files`, `folders`, `search`, `search:context`, `wordcount`, `vault`.
- Writing: `create`, `append`, `prepend`, `property:set`, `property:remove`, `delete`, `rename`, `move`.

Commands that need the app (`open`, `command`, `search:open`, `tab:open`, `random`) report that they are unsupported.
Everything else the Obsidian CLI offers, such as bookmarks, bases, tasks, plugins or sync history, reports an unknown
command.

## How Obsidian behaves

Rules backroom follows that were found by comparing with Obsidian, some of them surprising:

- **Sorting.** Listings sort ignoring case and accents, with numbers compared by value (`Note 2` before `Note 10`).
  Outgoing links (`links`) sort by code units instead, so uppercase comes first.
- **Tags.** The vault's tags count every occurrence, merge case variants under the spelling seen first, and include
  each parent of a nested tag, counting the occurrences below it. Excluded files do not count, but `tag` still lists
  them. A note's own tags keep case variants apart. Tags and links inside `%%` comments count; headings there do not.
- **Excluded files.** `userIgnoreFilters` entries are path prefixes matched ignoring case, so `archive` also excludes
  `Archive Generation Service.md`.
- **Links.** A link to the note itself counts as a link and a backlink. Unresolved links are named without `.md` and
  told apart by case. `orphans` and `deadends` include attachments whether `all` is given or not.
- **Paths.** Paths are shown in Unicode NFC, also when the file name is stored decomposed on disk.
- **Properties.** A note's frontmatter is printed re-serialized, with lists in block style. Built-in properties
  (`aliases`, `cssclasses`, `tags`) are listed even when unused, and types come from `types.json` or are inferred.
- **Word count.** A word is a run of letters, hyphens and straight apostrophes, or a number such as `3.14` or
  `1,000`. Chinese and Japanese characters count one word each. The frontmatter is skipped, comments and code are not.
- **Search.** All operators work: `file:`, `path:`, `content:`, `line:`, `block:`, `section:`, `task:`, `task-todo:`,
  `task-done:`, `tag:`, `match-case:`, `ignore-case:`, `[property]` and `[property:value]`. An unknown operator is an
  error.
- **Writes.** `create` on a taken path writes `Name 1.md`. `append` always adds a newline before the content.
  Removing the last property removes the frontmatter. Updated wikilinks lose a `.md` extension.

## Deliberate differences

| Behavior | Obsidian | backroom | Why |
| --- | --- | --- | --- |
| Changing a property | Rewrites the whole frontmatter in its own format | Changes only the property's text | ADR 2 |
| `property:set` without `type=` | Writes the value as text, `rating: "5"` | Uses the type from `types.json`, else the current value's | Keeps number and checkbox properties intact |
| `property:set` with `type=` | Records the type in `.obsidian/types.json` | Leaves `.obsidian/` alone | ADR 2 |
| `delete` | Moves to the system trash | Moves to `.trash/` | A server has no system trash (ADR 2) |
| `create ... overwrite` | Replaces the file | Needs `version=` | ADR 2 |
| Order of search results | The order Obsidian indexed the files in | Sorted like other listings | The index order is not knowable outside the app |
| Names that sort equal, like `Repository` and `repository` | Index order | Order found | Same |
| Errors | Exit code 0 | Exit code 1 | Lets scripts notice errors |
| `path=` with a decomposed name | File not found | Found | Paths are compared in NFC |

`sort=count` with equal counts follows the same index order in Obsidian, which is why it is not part of the
comparison.
