# Vision

## Problem

Obsidian vaults work well as a long-term memory for agents. With skills built on the Obsidian CLI, an agent can recall
things from a vault, write down notes worth keeping, and maintain the vault through progressive summarization and
distillation.

That only works where the Obsidian desktop app runs, because the Obsidian CLI is a remote control for a running app. On
a phone there is no Obsidian app an agent can drive. Running the desktop app on a server needs a virtual display and
other hacks, and Obsidian is closed source, so there is no headless version to run instead.

## What backrooms is

backrooms is a server that gives agents the same access to a vault that they have on a desktop with Obsidian running,
without Obsidian and without a GUI.

- It runs on a server and works on a git clone of the vault, the same repository the Obsidian Git plugin syncs on the
  user's devices.
- It implements a subset of the Obsidian CLI's features headlessly: reading and writing notes, search, links and
  backlinks, tags, and queries over properties and other metadata.
- It exposes those features through an MCP server, so agents such as the Claude mobile app can connect to it remotely.
  The same features are available as a CLI on the server.
- It commits and pushes its changes through git, and an agent can use git operations to look at or undo what it
  changed.

## Example requests

From an agent on a phone, connected to backrooms' MCP server:

- "What notes did I create yesterday?"
- "Add a new entry for today to my October note, I have some thoughts I want to write down."
- "Create a new note for this pizza recipe."
- "Distill my notes on X into a summary note."

Each of these should work the way it does on a desktop with Obsidian running, and the result should look right when the
vault is opened in Obsidian afterwards.

## Goals

- **Same behavior as Obsidian.** Links, tags, properties and search results match what Obsidian shows for the same
  vault (ADR 1).
- **Safe writes.** Agents write to the vault without a human reviewing each change, so a write never corrupts,
  reformats or silently overwrites a note (ADR 2). Git history is a second safety net, not the first one.
- **Runs headless on a small server** as a single binary (ADR 3, ADR 4).
- **Skills carry over.** Operations line up with the Obsidian CLI commands, so a skill written against the Obsidian CLI
  needs small changes, not a rewrite, to work against backrooms. A skill used remotely does without local vault paths,
  direct file edits and searches, and its own linting, since backrooms applies the Linter rules it supports to every
  note it saves.
- **Remote access** through MCP over HTTP with authentication (ADR 5).

## Non-goals

- **Replacing the Obsidian app.** backrooms has no UI. Obsidian stays the way people read and edit the vault on their
  devices.
- **Running community plugins.** Obsidian's plugins do not run in backrooms. The choice of TypeScript keeps the option
  open (ADR 4). Instead, backrooms reimplements the features of plugins it needs as its own plugins (ADR 7), starting
  with the Linter's timestamps, which queries over creation and modification dates rely on.
- **Its own sync protocol.** backrooms syncs through git and nothing else. It does not talk to Obsidian Sync.
- **Multiple users.** backrooms serves one person's vault. It does not manage accounts or permissions per user.
- **Full Obsidian CLI parity.** backrooms implements the commands agents need and reports everything else as
  unsupported.

## First operations

The first set of operations is what agents need for the example requests above and for recalling, capturing and
maintaining notes. [obsidian-cli-coverage.md](obsidian-cli-coverage.md) lists them.

## Open questions

- Is search plain text matching with Obsidian's search syntax, or does it also need semantic search over embeddings?
- How is backrooms packaged and deployed? Remote clients authenticate through backrooms' own OAuth server (ADR 8).
- One vault per process, or several?
- Does backrooms pick notes for review sessions itself, or does it offer queries that let an agent score them?
