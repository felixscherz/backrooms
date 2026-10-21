# backroom

A headless server for an Obsidian vault. backroom works on a git clone of the vault and implements a subset of the
Obsidian CLI without the Obsidian app, so agents can read, search and edit the vault from anywhere, for example from the
Claude app on a phone through MCP.

- [docs/vision.md](docs/vision.md) explains why backroom exists and what it is for.
- [docs/obsidian-cli-coverage.md](docs/obsidian-cli-coverage.md) lists the Obsidian CLI features backroom needs.
- [docs/adr/](docs/adr/) holds the architecture decisions.

## Development

backroom is written in TypeScript and runs on [Bun](https://bun.com).

```bash
bun install
bun test
bun run typecheck
```
