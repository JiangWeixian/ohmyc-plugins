# @ohmyc/timeline-plugin

## 1.0.6

### Patch Changes

- 69e72bb: Add Codex plugin icon and logo assets so the Timeline plugin appears with OhMyC branding in plugin marketplaces.
- 0ec961a: Align CI workflows with ohmyc changesets pattern
- 7e8dce5: Include built runtime files in the repository so Git-backed Codex installs have the packaged hook entrypoints available. Document installation paths for Claude Code, Codex, and OpenCode users, and move contributor setup into a dedicated guide.
- dbf0528: Make OpenCode session checkpoints idempotent across duplicate events, resumed sessions, generated titles, and child tool calls.
- d9a6d4e: Switch opencode plugin from node:sqlite to native bun:sqlite driver
