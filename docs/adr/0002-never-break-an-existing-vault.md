# 2. Never break an existing vault

- Status: Proposed
- Date: 2026-10-21

## Context

Users point this project at the vault they rely on every day. Agents write to it, often without a human reviewing each
change, and Obsidian, sync tools and the user may change the same files at the same time. A corrupted note, a
reformatted file, a lost edit or a broken link damages the user's trust in their vault, and may go unnoticed for a long
time.

"Never break the vault" has to be a property of the write path, not a promise each feature keeps on its own.

## Decision

All changes to a vault go through one write path that enforces these rules. No interface or feature writes files
directly.

- **Change only what was asked.** A write replaces exactly the intended range of a file. Every other byte stays as it
  was, including line endings, whitespace, frontmatter formatting, key order and YAML comments. Properties are edited
  in place in the YAML text, never by serializing a parsed object back out.
- **No lost updates.** Every change to an existing file names the version of the file it is based on (a content hash).
  If the file changed since then, the write is rejected and the caller has to read it again. backrooms processes on
  the same vault take turns through a lock, so one write cannot land between another's version check and its rename.
- **All or nothing.** A change that touches several files, such as a rename that rewrites links, is planned and
  validated completely before the first write. Each file is written atomically (temporary file in the same directory,
  then rename). If applying the change fails part way, the files already written are restored.
- **Nothing is destroyed.** Deleting a note moves it to the vault's `.trash/` folder, the way Obsidian does by default.
  Overwriting a different existing file is never a side effect of creating or moving one.
- **Only valid results.** File names that Obsidian cannot create or link to are rejected. A rename that cannot update
  every link to the note unambiguously is rejected, not partially applied.
- **Hands off Obsidian's files.** The write path refuses to touch `.obsidian/` and other hidden folders, except for
  moving notes into `.trash/`.
- **Refuse when unsure.** When the project cannot tell how Obsidian would interpret a file, for example malformed
  frontmatter, it reads what it can but rejects writes that depend on the unclear part.

These rules are tested directly: a write that changes nothing produces a byte-identical file, every write leaves all
untouched bytes intact, and concurrent edits are detected.

## Consequences

- Agents get errors in situations where a looser tool would have guessed. Callers have to handle rejected writes,
  mostly by reading the file again and retrying.
- Editing properties needs a YAML editor that preserves formatting, which is more work than parse and serialize.
- Git history (ADR 6) is a second safety net, since every write becomes a commit that can be reverted. The rules above
  do not depend on it and hold on a vault without git.
