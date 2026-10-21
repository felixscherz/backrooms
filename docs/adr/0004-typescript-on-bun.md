# 4. TypeScript on Bun

- Status: Proposed
- Date: 2026-10-21

## Context

Community plugins are a large part of why people use Obsidian. They are JavaScript bundles written against Obsidian's
`obsidian` API (`App`, `Vault`, `MetadataCache` and others). Supporting even the plugins that mostly read data, such as
Dataview's query engine, requires running JavaScript and providing an implementation of that API. Plugin support is
not planned yet, but the language choice decides whether it stays possible.

The project should also be easy to deploy on a server, ideally as a single file.

## Decision

The project is written in TypeScript with strict type checking and runs on Bun. Releases are built as a single
executable with `bun build --compile`.

The engine's own model should not mirror Obsidian's plugin API. If plugin support is added later, a separate adapter
implements the `obsidian` API on top of the engine.

## Consequences

- Plugins could later run in the same process as the engine, without a bridge between languages.
- Deployment is one binary per platform, without a separate runtime installation.
- Bun provides SQLite (`bun:sqlite`), a test runner and a bundler, which keeps the dependency list short.
- The project depends on Bun's Node compatibility for any npm package that assumes Node.
- A Go binary would be somewhat smaller, but would rule out running plugins in process.
