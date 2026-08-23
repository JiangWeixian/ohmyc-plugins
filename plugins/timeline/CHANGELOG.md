# @ohmyc/timeline-plugin

## 1.0.7

### Patch Changes

- 9661788: Move the plugin into `plugins/timeline/` so Codex can install it.

  Both marketplace manifests declared the plugin at the repository root
  (`"path": "./"`). Codex accepts a marketplace declared that way but enumerates
  no plugins from it, so `codex plugin add timeline@ohmyc` failed with
  "plugin `timeline` was not found in marketplace `ohmyc`" and nothing reported a
  problem upstream. The plugin now lives in a subdirectory that both manifests
  point at, which Claude Code accepts as well.

  The published package is unaffected: npm packs relative to `package.json`, which
  moved with the plugin, so the tarball keeps the same internal layout. The one
  exception is `.agents`, which is no longer part of the package — the marketplace
  manifests and the repo's own skills stay at the repository root.

## 1.0.6

### Patch Changes

- 69e72bb: Add Codex plugin icon and logo assets so the Timeline plugin appears with OhMyC branding in plugin marketplaces.
- 0ec961a: Align CI workflows with ohmyc changesets pattern
- 7e8dce5: Include built runtime files in the repository so Git-backed Codex installs have the packaged hook entrypoints available. Document installation paths for Claude Code, Codex, and OpenCode users, and move contributor setup into a dedicated guide.
- dbf0528: Make OpenCode session checkpoints idempotent across duplicate events, resumed sessions, generated titles, and child tool calls.
- d9a6d4e: Switch opencode plugin from node:sqlite to native bun:sqlite driver
