# 5. CLI and MCP server as interfaces over one engine

- Status: Proposed
- Date: 2026-10-21

## Context

Two kinds of users drive the vault engine. People and scripts work in a shell. AI agents connect through the Model
Context Protocol (MCP), either locally (for example Claude Code on a laptop) or remotely (for example the Claude mobile
app reaching a server). Both need the same operations: read notes and their outline, properties, tags and links,
search, list backlinks, aliases and unresolved links, create, edit, append to, rename, move and delete notes, and set
properties. [obsidian-cli-coverage.md](../obsidian-cli-coverage.md) lists them with the Obsidian CLI commands they
correspond to.

A remote agent has no access to the vault's files, so every operation an agent performs on the files directly when it
runs next to the vault, such as editing part of a note, has to be an operation here.

If each interface implemented these operations itself, they would drift apart, and the write rules of ADR 2 would have
to be enforced twice.

## Decision

The project offers two interfaces, a CLI and an MCP server, as thin layers over the same engine operations.

- Each vault operation exists once in the engine. The CLI command and the MCP tool for it only translate arguments and
  results.
- Both ship in the same executable, for example `backroom read path="Note.md"` and `backroom mcp`.
- Commands follow the Obsidian CLI for the features backroom supports: the same command names, `key=value`
  parameters and output formats. Agents and skills written against the Obsidian CLI then need few changes. MCP tools use
  the same names, with `:` replaced by `_` (`search:context` becomes `search_context`), because MCP tool names do not
  allow colons. Operations the Obsidian CLI has no command for get their own names.
- The MCP server supports the stdio transport for local clients and the streamable HTTP transport for remote clients.
  Remote access requires authentication. How authentication and deployment work is decided in a later ADR.

## Consequences

- Every operation can be tried and debugged from the shell before an agent uses it.
- Adding an operation means adding it to the engine and exposing it in both interfaces.
- CLI output and MCP results are two formats of the same data, so they need to be kept consistent, for example through
  tests that run the same operation through both.
