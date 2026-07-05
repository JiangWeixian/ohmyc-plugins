# OhMyC Timeline Plugin

[![CI](https://img.shields.io/github/actions/workflow/status/JiangWeixian/ohmyc-plugins/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/JiangWeixian/ohmyc-plugins/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=nodedotjs)](package.json)
[![Bun](https://img.shields.io/badge/bun-1.3.12-000000?style=flat-square&logo=bun)](.github/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](package.json)

Collects session data from **Claude Code**, **OpenCode**, and **Codex** agents and ingests it into the OhMyC Timeline dashboard.

## Supported Agents

| Agent | Integration | Data Source |
|-------|-------------|-------------|
| Claude Code | Stop hook via `hooks/hooks.json` and `hooks/ingest-claude.sh` | Claude JSONL transcripts in `~/.claude/projects/` |
| Codex | Codex plugin manifest, default `hooks/hooks.json`, and `hooks/ingest-codex.sh` | Codex JSONL sessions in `~/.codex/sessions/` and `~/.codex/archived_sessions/` |
| OpenCode | OpenCode plugin entry at `opencode.ts` | Real-time OpenCode lifecycle, message, and tool events |

## Requirements

- Node.js 22 or later for the Claude Code and Codex hook runtime.
- Bun 1.3.x when building from source or running the development test suite.
- `jq` is optional. Hook scripts use it for a faster transcript parse and fall back to Node when it is unavailable.
- One supported host: Claude Code, Codex, or OpenCode.

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

For a local checkout, run Claude Code from this repository and add the local marketplace instead:

```text
/plugin marketplace add .
/plugin install timeline@ohmyc
```

The installed Stop hook calls:

```bash
${CLAUDE_PLUGIN_ROOT}/hooks/ingest-claude.sh $CLAUDE_SESSION_ID
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

For local testing, point Codex at the checkout:

```bash
codex plugin marketplace add "$(pwd)"
```

The installed Stop hook calls:

```bash
${PLUGIN_ROOT}/hooks/ingest-codex.sh
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

For local testing from this checkout, build the plugin and copy the OpenCode bundle into your project plugin directory:

```bash
bun install --frozen-lockfile
bun run build
mkdir -p .opencode/plugins
cp dist/index.js .opencode/plugins/timeline.js
```

OpenCode loads files from `.opencode/plugins/` at startup. The plugin records session lifecycle, message, and tool events through the hooks exported by `opencode.ts`.

Official OpenCode plugin docs: <https://opencode.ai/docs/plugins/>

## Configuration

| Option | Type | Default | Example | Description |
| --- | --- | --- | --- | --- |
| `OHMYC_HOME` | environment variable | `~/.config/ohmyc` | `/tmp/ohmyc` | Directory containing `timeline.db`. |
| `AGENT_HOME` | environment variable | `~/.claude` | `/tmp/.claude` | Claude transcript root used by `ingest-claude.sh`. |
| `CODEX_HOME` | environment variable | `~/.codex` | `/tmp/.codex` | Codex session root used by `ingest-codex.sh`. |

## Contributing

For local setup, build commands, tests, commit style, and pull request expectations, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Runtime Details

### Claude Code

Claude Code reads `.claude-plugin/plugin.json` and `hooks/hooks.json`. The shared Stop hook dispatches Claude sessions to:

```bash
${CLAUDE_PLUGIN_ROOT}/hooks/ingest-claude.sh $CLAUDE_SESSION_ID
```

`ingest-claude.sh` searches `~/.claude/projects/` for the matching transcript and uses the Claude jq fast path when jq is available. If jq is unavailable or the fast path fails, the bundled Node entry at `dist/ingest.mjs` parses the transcript with `--agent-name claude`.

### Codex

Codex discovers the plugin from `.codex-plugin/plugin.json`. Codex plugin lifecycle hooks use the default `hooks/hooks.json`; the shared Stop hook dispatches Codex sessions to:

```bash
${PLUGIN_ROOT}/hooks/ingest-codex.sh
```

`ingest-codex.sh` reads Codex hook input from stdin. It accepts `transcript_path` directly, or searches `~/.codex/sessions/` and `~/.codex/archived_sessions/` by `session_id`. It uses a Codex-specific jq fast path when jq is available, and falls back to the bundled Node parser with `--agent-name codex`; both paths emit the same `ParsedSessionData` shape.

### Node Hook Runtime

The Claude and Codex hook runtime requires Node 22+ and uses Node's built-in `node:sqlite` module. The plugin does not require `better-sqlite3` or a system `sqlite3` command.

### OpenCode

The OpenCode plugin lives at `opencode.ts` and sets `agentName='opencode'`. It hooks into:

- `session.created`, `session.idle`, and `session.deleted`
- `message.updated`
- `message.part.updated`
- `tool.execute.before` and `tool.execute.after`

## Shared Output

All agents write to the same SQLite database:

```text
~/.config/ohmyc/timeline.db
```

The shared writer contract is `ParsedSessionData` from `@ohmyc/timeline`. Agent-specific collectors normalize their native event or transcript format into that contract before writing.
