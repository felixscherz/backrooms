# 1. Obsidian compatibility is the core contract

- Status: Proposed
- Date: 2026-10-21

## Context

The project gives agents and scripts access to an Obsidian vault without running Obsidian. Its users keep using
Obsidian on their devices for the same vault. If this project interprets the vault differently from Obsidian, for
example by resolving a link to another note or missing a tag, agents act on a wrong picture of the vault and their edits
look wrong when opened in Obsidian.

Obsidian is closed source. Its behavior is defined by what the app does, partly documented in the Obsidian help.

## Decision

Obsidian's behavior is the specification. Where this project and Obsidian disagree about how to read a vault, this
project has a bug.

- The vault on disk is the only source of truth. The project stores nothing inside the vault that Obsidian does not
  store there itself. Indexes and caches live outside the vault directory.
- The project reads the vault's own Obsidian settings in `.obsidian/` (such as link format, attachment folder and
  excluded files) and follows them. It never writes to `.obsidian/`.
- Each supported behavior is pinned by a compatibility test: a small synthetic vault in the repository plus the result
  Obsidian gives for it. Where the documentation is silent, the expected result is checked in the real Obsidian app
  before the test is written, and the test records the Obsidian version it was checked against.
- The project only implements Obsidian behavior it has pinned this way. Behavior it does not support is reported as
  unsupported, never approximated silently.
- The supported target is the current public Obsidian release, starting with 1.12.

## Consequences

- Users can point the project at an existing vault without converting or annotating it.
- Every feature needs a compatibility test before it ships, which makes features slower to add.
- Obsidian can change behavior in a new release. The compatibility tests show which behaviors to re-check when the
  target version moves.
- Features outside Obsidian's core, such as community plugins, are not part of this contract until a later decision
  adds them.
