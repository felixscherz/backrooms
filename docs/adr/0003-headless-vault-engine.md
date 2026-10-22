# 3. Headless vault engine instead of the Obsidian app

- Status: Proposed
- Date: 2026-10-21

## Context

The project has to run on a server without a display. Obsidian's official CLI is a remote control for a running
Obsidian desktop app. Running the desktop app on a server needs a virtual display (Xvfb), uses several hundred MB of
memory per vault, and is fragile to operate. The official Obsidian Headless client only handles Sync and Publish, not
reading or editing notes. Obsidian is closed source, so its code cannot be reused.

A vault is a folder of plain files: markdown with YAML frontmatter, wikilinks, tags and attachments. The behavior an
agent needs, such as parsing notes, resolving links, backlinks, search and renaming, can be reimplemented on those
files.

## Decision

The project contains its own vault engine that reads and writes the vault folder directly and reproduces Obsidian's
behavior as defined in ADR 1. It never depends on the Obsidian app, Electron, a display or Obsidian's code, and it runs
as a plain process on a server.

The engine is a library. Interfaces (ADR 5) are built on top of it.

## Consequences

- The project runs anywhere the runtime runs: a VM, a container, a CI job or a laptop.
- Every Obsidian behavior the project supports has to be reimplemented and kept in line with Obsidian, which ADR 1's
  compatibility tests cover.
- Community plugins do not run, because they need Obsidian's API. ADR 4 keeps the option open to support some of them
  later. Until then, plugin features are only available where backroom reimplements them (ADR 7).
- Reimplementing behavior from documentation and observation is allowed. Copying code from Obsidian's bundled app is
  not.
