# 7. Plugins reimplemented in backrooms

- Status: Proposed
- Date: 2026-10-22

## Context

Community plugins change what a vault looks like. The Linter plugin, for example, records `date_created` and
`date_modified` in the frontmatter of every note it lints. In the personal vault the `second-brain` skill lints each note
it writes, and the timestamps are what queries such as "what did I create yesterday" rely on. A note written through
backrooms without them stays without them until it is next edited in Obsidian.

ADR 3 rules out running Obsidian's plugins as they are, and ADR 4 keeps running them through an adapter for Obsidian's
API as a later option. Most of what a plugin like the Linter does is small, well-defined text transformations that
can be reimplemented on their own, as backrooms already does for Obsidian's core behavior.

## Decision

backrooms reimplements selected features of community plugins as its own plugins, compiled into backrooms.

- **One plugin per Obsidian plugin.** A backrooms plugin carries the id of the Obsidian plugin it reimplements, such as
  `obsidian-linter`. It is active when the vault enables that id in `.obsidian/community-plugins.json`, and it reads
  its settings from `.obsidian/plugins/<id>/data.json`, the file the Obsidian plugin keeps them in. backrooms has no
  plugin settings of its own, so the plugin behaves as configured in Obsidian.
- **Hooks into the engine.** The first hook is `onSave`: it gets a note that a write saves and returns the text to save
  instead. A note is saved when a command creates or changes it, as `create`, `append`, `prepend`, `edit` and
  `property:set` do. Notes changed as a side effect, such as the links that a rename updates, are not saved, just as
  Obsidian's Linter does not lint them. A revert restores old content and saves nothing.
- **A subset, checked against the plugin.** A backrooms plugin implements part of the Obsidian plugin's features, such
  as some of the Linter's rules. It reports the features the vault enables that it does not implement. What it
  implements is pinned by the compatibility tests of ADR 1, with the Obsidian plugin installed in test-vault.
- **Refuse settings it cannot follow.** When a plugin's settings ask for something the backrooms plugin cannot do the
  way the Obsidian plugin does it, such as a date format it does not support, writes fail with an error instead of
  saving a note the Obsidian plugin would have written differently.
- **The write path stays in charge.** A plugin's change is part of the write and goes through the rules of ADR 2. It
  only edits what its feature is about, in place: the Linter's timestamps change the lines of those two properties and
  leave every other byte of the frontmatter as it was. Plugins never write files themselves and never touch
  `.obsidian/`.

ADR 2's "change only what was asked" includes what the vault's enabled plugins do on save: a vault that enables the
Linter asks for timestamps on every note it saves.

## Consequences

- Notes written through backrooms look like notes written in Obsidian with the same plugins, and stay queryable the
  same way.
- Each plugin feature is work to reimplement and to keep in line with new versions of the plugin, like Obsidian's own
  behavior.
- Plugins whose effects cannot be reimplemented as text transformations, such as ones that render views or run user
  scripts (Dataview, Templater), stay out of scope. They would need the adapter that ADR 4 keeps possible.
- The plugin interface lives inside backrooms. Third parties cannot add plugins without changing backrooms.
