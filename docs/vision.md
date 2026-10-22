# Vision

## Problem

I keep my notes in an Obsidian vault and I work with them through agents. Skills tell an agent how to use the Obsidian
CLI to recall things from the vault, write down notes I want to keep, and maintain the vault through progressive
summarization and distillation.

That only works on my laptop, because the Obsidian CLI is a remote control for a running Obsidian desktop app. On my
phone there is no Obsidian app an agent can drive. Running the desktop app on a server needs a virtual display and other
hacks, and Obsidian is closed source, so there is no headless version to run instead.

## What backroom is

backroom is a server that gives agents the same access to my vault that they have on my laptop, without Obsidian and
without a GUI.

- It runs on my VM and works on a git clone of the vault, the same repository the Obsidian Git plugin syncs on my
  devices.
- It implements a subset of the Obsidian CLI's features headlessly: reading and writing notes, search, links and
  backlinks, tags, and queries over properties and other metadata.
- It exposes those features through an MCP server, so the Claude app on my phone can connect to it remotely. The same
  features are available as a CLI on the server.
- It commits and pushes its changes through git, and an agent can use git operations to look at or undo what it
  changed.

## Example requests

From the Claude app on my phone, connected to backroom's MCP server:

- "What notes did I create yesterday?"
- "Add a new entry for today to my October note, I have some thoughts I want to write down."
- "Create a new note for this pizza recipe."
- "Distill my notes on X into a summary note."

Each of these should work the way it does on my laptop with Obsidian running, and the result should look right when I
open the vault in Obsidian afterwards.

## Goals

- **Same behavior as Obsidian.** Links, tags, properties and search results match what Obsidian shows for the same
  vault (ADR 1).
- **Safe writes.** Agents write to the vault without a human reviewing each change, so a write never corrupts,
  reformats or silently overwrites a note (ADR 2). Git history is a second safety net, not the first one.
- **Runs headless on a small VM** as a single binary (ADR 3, ADR 4).
- **Skills carry over.** Operations line up with the Obsidian CLI commands my existing skills use, so a skill needs
  small changes, not a rewrite, to work against backroom. The `second-brain` skill needs a remote mode: no local vault
  paths, no edits or `rg` searches on the files directly, and no linting, since backroom applies the Linter rules it
  supports to every note it saves.
- **Remote access from my phone** through MCP over HTTP with authentication (ADR 5).

## Non-goals

- **Replacing the Obsidian app.** backroom has no UI. I keep using Obsidian on my devices for the same vault.
- **Running community plugins.** Obsidian's plugins do not run in backroom. The choice of TypeScript keeps the option
  open (ADR 4). Instead, backroom reimplements the features of plugins it needs as its own plugins (ADR 7), starting
  with the Linter's timestamps, which the skill relies on.
- **Its own sync protocol.** backroom syncs through git and nothing else. It does not talk to Obsidian Sync.
- **Multiple users.** backroom serves one person's vault. It does not manage accounts or permissions per user.
- **Full Obsidian CLI parity.** backroom implements the commands agents need and reports everything else as
  unsupported.

## First operations

The first set of operations is what the `second-brain` skill uses today, plus what the example requests above need.
[obsidian-cli-coverage.md](obsidian-cli-coverage.md) lists them.

## Open questions

- Is search plain text matching with Obsidian's search syntax, or does it also need semantic search over embeddings?
- How is backroom deployed on the VM? Remote clients authenticate through backroom's own OAuth server (ADR 8).
- One vault per process, or several?
- Does backroom pick seed notes for review sessions itself, or does it offer queries that let an agent do the scoring
  that `pick_review.py` does today?
