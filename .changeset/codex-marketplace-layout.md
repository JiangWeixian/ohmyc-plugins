---
"@ohmyc/timeline-plugin": patch
---

Move the plugin into `plugins/timeline/` so Codex can install it.

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
