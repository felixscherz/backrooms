# 6. Sync the vault through git

- Status: Proposed
- Date: 2026-10-21

## Context

backroom runs on a server, while the user edits the same vault in Obsidian on their devices. The devices already sync
the vault through a git repository with the Obsidian Git plugin, which commits, pulls and pushes on an interval.
backroom needs a copy of the vault on its own disk and has to exchange changes with the devices.

Git also gives a history of every change. Agents write without a human reviewing each change, so being able to see and
undo what an agent did is useful on its own, not only for sync.

## Decision

backroom works on a local clone of the vault's git repository and syncs it with the remote the same way the Obsidian
Git plugin does.

- **Pull before work.** backroom pulls on an interval and before each write. A pull that changes a file invalidates
  earlier reads of it, so a write based on an older version is rejected by the version check of ADR 2.
- **One commit per write operation.** Each successful write operation, such as creating a note or renaming one with its
  link updates, becomes one commit with a message describing the operation. backroom pushes after each commit.
- **Never rewrite shared history.** backroom never force pushes. If a push is rejected, it pulls with rebase and pushes
  again. If the rebase conflicts, backroom aborts it, keeps its local commits, stops syncing and reports the conflict.
  A human resolves it.
- **Git operations for agents.** The engine exposes a small set of git operations: status, log, diff of a commit, and
  revert of a commit backroom made. Revert adds a new commit and goes through the same write path. Operations that
  discard history, such as `reset --hard`, are not exposed.
- **Git CLI.** backroom runs the `git` executable instead of a JavaScript git implementation. Git is available on any
  server, and the user's repository may use features a library does not support.
- **Credentials.** The server authenticates to the remote with a key scoped to the vault repository.

## Consequences

- Changes made from the phone reach the laptop on the Obsidian Git plugin's next pull, and the other way around. Edits
  are not visible instantly on the other side.
- Every agent change is a separate commit, so it can be inspected and reverted without affecting other changes.
- The history gets many small commits, more than a human would make.
- A sync conflict blocks syncing until a human resolves it. backroom keeps working on its local clone in the meantime,
  and the conflict shows up in its status.
- Deployment needs `git` installed next to the backroom binary, a small exception to the single-binary goal of ADR 4.
