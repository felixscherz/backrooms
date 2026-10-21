# Obsidian CLI coverage

Which Obsidian CLI features backroom needs, taken from what the `second-brain` skill uses today. The skill's
references (`search.md`, `write.md`, `curate.md`, `maintain.md`, `conventions.md`) list the commands below.

Every command takes `vault=<name>`. backroom serves one vault, so it can accept and ignore that parameter or drop it.

[compatibility.md](compatibility.md) tracks what backroom implements so far and how closely it matches Obsidian.

## Commands the skill calls

| Command | Parameters used | Used for |
| --- | --- | --- |
| `read` | `path` | reading a note |
| `outline` | `path`, `format=json` | headings of a note |
| `properties` | `path`, `format=json` | frontmatter of a note |
| `tags` | `path`, `format=json` | tags of one note |
| `tags` | `counts`, `sort=count`, `format=json` | all tags in the vault with counts |
| `tag` | `name`, `verbose` | notes with a tag |
| `links` | `path` | outgoing links of a note |
| `backlinks` | `path`, `format=json`, `counts` | incoming links of a note |
| `search` | `query` | full-text search, including `#tag` queries |
| `search:context` | `query`, `format=json` | search with matching lines |
| `aliases` | `verbose` | all aliases in the vault |
| `files` | `folder`, `ext=md` | listing notes in a folder |
| `unresolved` | `counts`, `verbose`, `format=json` | links that point to no note |
| `create` | `path`, `content` | creating a note |
| `rename` | `path`, `name` | renaming a note and updating links |
| `move` | `path`, `to` | moving a note and updating links |
| `property:set` | `path`, `name`, `value`, `type` | setting one frontmatter property |

## Operations the skill does outside the CLI

On the laptop the agent has the vault on disk and does these with its own file tools. A remote agent only has backroom,
so backroom has to offer them.

- **Editing part of a note.** Curation and review sessions make "small, precise file edits", for example replacing a
  passage or adding a `## Related` section. backroom needs an edit operation that replaces an exact range or string,
  checked against the file version per ADR 2.
- **Deleting a note.** Review sessions delete worthless notes and merged duplicates. backroom moves them to `.trash/`
  per ADR 2.
- **Picking review seeds.** `scripts/pick_review.py` reads every root-level note to score it by `#inbox`,
  `#temporal-notes`, orphan status and age. Either backroom offers this as an operation, or it offers queries rich
  enough (properties, tags, orphans, modification dates) for an agent to do the scoring itself.
- **Fallback to `rg`.** The skill falls back to `rg` when Obsidian is not running. With backroom there is nothing to
  fall back to, so its search has to cover what `rg` was used for.

## Not covered

- **Linting with `open` and `command id=obsidian-linter:lint-file`.** This runs the Linter community plugin inside the
  app. Community plugins are a non-goal for now, so backroom does not support it. The skill has to skip linting when it
  talks to backroom.

## Needed for the example requests

The example requests in [vision.md](vision.md) need some things the skill does not use yet.

- "What notes did I create yesterday?" needs a query over `date_created` (or file creation time), such as a `files`
  listing with a property filter.
- "Add a new entry for today to my October note" needs to find the monthly note and append to a section of it. An
  append operation (the Obsidian CLI has `append`) or the edit operation above covers this.
