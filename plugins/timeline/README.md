# OhMyC Timeline Plugin

[![CI](https://img.shields.io/github/actions/workflow/status/JiangWeixian/ohmyc-plugins/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/JiangWeixian/ohmyc-plugins/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=nodedotjs)](package.json)
[![Bun](https://img.shields.io/badge/bun-1.3.12-000000?style=flat-square&logo=bun)](.github/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](package.json)

Collects local session data from **Claude Code**, **Codex**, **Cursor CLI**, **Grok Build**, and **OpenCode** and ingests it into the OhMyC Timeline dashboard.

## Supported Agents

| Agent | Integration | Data Source |
|-------|-------------|-------------|
| Claude Code | Stop hook via `hooks/hooks.json` and `hooks/ingest-claude.sh` | Claude JSONL transcripts in `~/.claude/projects/` |
| Codex | Codex plugin manifest, default `hooks/hooks.json`, and `hooks/ingest-codex.sh` | Codex JSONL sessions in `~/.codex/sessions/` and `~/.codex/archived_sessions/` |
| Cursor CLI | Native Cursor plugin hooks | Hook events plus the transcript path supplied by Cursor when available |
| Grok Build | Native Grok plugin hooks | Hook events and the matching session files under `$GROK_HOME/sessions/` |
| OpenCode | OpenCode plugin entry at `opencode.ts` | Real-time OpenCode lifecycle, message, and tool events |

Cursor CLI `2026.09.10-fd3934a` verified local custom-manifest hook loading,
and Grok Build `1.0.25` validated this plugin's custom hooks manifest. Full
installed collector acceptance is tracked separately; these are verified
configuration targets, not claimed minimum versions.

## Requirements

- Node.js 22 or later for the Claude Code, Codex, Cursor, and Grok hook
  runtimes. If `node` is unavailable, native hooks fail open and cannot record
  the event.
- Bun 1.3.x when building from source or running the development test suite.
- `jq` is optional. Hook scripts use it for a faster transcript parse and fall back to Node when it is unavailable.
- One supported host: Claude Code, Codex, Cursor CLI, Grok Build, or OpenCode.
- An OhMyC App version that understands Timeline token completeness. Cursor
  currently records token status as unavailable; Grok records complete or
  partial usage only when its validated session usage file provides it. Older
  App versions can display unavailable numeric slots as zero.

## Quick Start

Install the plugin in the agent you use, then run a session normally. The plugin writes Timeline data to:

```text
~/.config/ohmyc/timeline.db
```

Set `OHMYC_HOME` before starting the agent if you want the database somewhere else.

## Installation

### Claude Code

Claude Code installs plugins from marketplaces. Add this repository's marketplace and install the `timeline` plugin:

```text
/plugin marketplace add JiangWeixian/ohmyc-plugins
/plugin install timeline@ohmyc
```

Official Claude Code plugin docs: <https://code.claude.com/docs/en/discover-plugins>

### Codex

Codex also discovers plugins through marketplaces. Add this repository as a marketplace:

```bash
codex plugin marketplace add JiangWeixian/ohmyc-plugins
```

Then open the plugin browser and install **OhMyC Timeline** from the `ohmyc` marketplace:

```text
codex
/plugins
```

Official Codex plugin docs: <https://developers.openai.com/codex/plugins>

### OpenCode

OpenCode can load plugins from npm packages or local plugin files. If you use the package form, add the package name to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@ohmyc/timeline-plugin"]
}
```

The plugin records session lifecycle, message, and tool events through OpenCode hooks.

Official OpenCode plugin docs: <https://opencode.ai/docs/plugins/>

### Cursor CLI

Cursor CLI `2026.09.10-fd3934a` can load the plugin directly from a checkout:

```bash
cursor-agent --plugin-dir "$(pwd)/plugins/timeline" --workspace /path/to/project
```

You can also add this repository to Cursor's marketplace index for discovery:

```bash
cursor-agent plugin marketplace add https://github.com/JiangWeixian/ohmyc-plugins.git
```

This Cursor CLI version exposes marketplace indexing but no CLI plugin install
command. Use `--plugin-dir` to run the plugin in verified local CLI sessions;
adding the marketplace alone does not install or execute it.

Cursor collection begins with events observed after installation. If Cursor
does not provide `transcript_path`, Timeline still records observable lifecycle
and tool activity, but it cannot reconstruct transcript-only details or exact
turn counts that lack stable native IDs. Cursor CLI does not expose a verified
transcript-disable control in this tested version.

### Grok Build

Add the marketplace, then install and trust the plugin so its hooks can run:

```bash
grok plugin marketplace add JiangWeixian/ohmyc-plugins
grok plugin install timeline --trust
```

For local development, install the plugin directory directly:

```bash
grok plugin install "$(pwd)/plugins/timeline" --trust
```

Grok collection begins with events observed after installation. It enriches
them only from the exact matching local session directory. Missing or partial
summary, history, or usage files stay queued for a later hook or manual replay.

## Configuration

| Option | Type | Default | Example | Description |
| --- | --- | --- | --- | --- |
| `OHMYC_HOME` | environment variable | `~/.config/ohmyc` | `/tmp/ohmyc` | Directory containing `timeline.db`. |
| `AGENT_HOME` | environment variable | `~/.claude` | `/tmp/.claude` | Claude transcript root used by `ingest-claude.sh`. |
| `CODEX_HOME` | environment variable | `~/.codex` | `/tmp/.codex` | Codex session root used by `ingest-codex.sh`. |
| `GROK_HOME` | environment variable | `~/.grok` | `/tmp/.grok` | Grok session root used for session enrichment. |

## Recover Pending Events

Hooks durably queue an event before attempting the Timeline database write. If
the final hook could not acquire the session lock or the database was busy,
replay queued events from the repository checkout:

```bash
node plugins/timeline/dist/ingest.mjs --replay-pending
```

The command uses `OHMYC_HOME` when set. Normal hooks run the bundled file
directly and do not install dependencies with `npx`.

## Contributing

For local setup, agent testing from a checkout, build commands, tests, commit style, and pull request expectations, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Shared Output

All agents write to the same SQLite database:

```text
~/.config/ohmyc/timeline.db
```

The shared writer contract is `ParsedSessionData` from `@ohmyc/timeline`. Agent-specific collectors normalize their native event or transcript format into that contract before writing.
