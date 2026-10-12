# OhMyC Timeline Plugin

[![CI](https://img.shields.io/github/actions/workflow/status/JiangWeixian/ohmyc-plugins/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/JiangWeixian/ohmyc-plugins/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=nodedotjs)](package.json)
[![Bun](https://img.shields.io/badge/bun-1.3.12-000000?style=flat-square&logo=bun)](.github/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](package.json)

Collects local session data from **Claude Code**, **Codex**, **Cursor CLI**, **Grok Build**, **Kimi Code CLI**, **ZCode**, and **OpenCode** and ingests it into the OhMyC Timeline dashboard.

## Supported Agents

| Agent | Integration | Data Source |
|-------|-------------|-------------|
| Claude Code | Stop hook via `hooks/hooks.json` and `hooks/ingest-claude.sh` | Claude JSONL transcripts in `~/.claude/projects/` |
| Codex | Codex plugin manifest, default `hooks/hooks.json`, and `hooks/ingest-codex.sh` | Codex JSONL sessions in `~/.codex/sessions/` and `~/.codex/archived_sessions/` |
| Cursor CLI | Native Cursor plugin hooks | Hook events plus the transcript path supplied by Cursor when available |
| Grok Build | Native Grok plugin hooks | Hook events and the matching session files under `$GROK_HOME/sessions/` |
| Kimi Code CLI | Native Kimi plugin hooks | Session index, metadata, and main-agent wire records under `$KIMI_CODE_HOME` |
| ZCode | Native ZCode plugin hooks | Native turn and tool IDs; temporary per-hook transcript when needed |
| OpenCode | OpenCode plugin entry at `opencode.ts` | Real-time OpenCode lifecycle, message, and tool events |

Cursor CLI `2026.09.10-fd3934a` verified local custom-manifest hook loading,
and Grok Build `1.0.25` / `1.0.30` were tested with an additional native hook
registration. Plugin installation alone did not activate Grok hooks in these
builds. Grok installation support remains incomplete; see the
[verification report](../../docs/verification/cursor-grok-timeline.md). These
are tested versions, not claimed minimum versions.

## Requirements

- Node.js 22 or later for the Claude Code, Codex, Cursor, Grok, Kimi, and ZCode hook
  runtimes. If `node` is unavailable, native hooks fail open and cannot record
  the event.
- Bun 1.3.x when building from source or running the development test suite.
- `jq` is optional. Hook scripts use it for a faster transcript parse and fall back to Node when it is unavailable.
- One supported host: Claude Code, Codex, Cursor CLI, Grok Build, Kimi Code CLI, ZCode, or OpenCode.
- Cursor and ZCode record token status as unavailable; Grok records complete or partial
  usage only when its validated session usage file provides it. This integration
  preserves the existing OhMyC UI; numeric displays may show zero for unavailable
  usage. The stored token status distinguishes it from measured zero.

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

The following commands install and trust the plugin. On the tested Grok
Build 1.0.25 and 1.0.30 versions, this alone does not activate its hooks. A
one-time native hook registration worked in isolated tests, but its setup
workflow is not yet included; this integration is not ready for release.

```bash
grok plugin marketplace add JiangWeixian/ohmyc-plugins
grok plugin install timeline --trust
```

For local development, install the plugin directory directly:

```bash
grok plugin install "$(pwd)/plugins/timeline" --trust
```

Grok collection begins with events observed after installation. It enriches
them only from the exact matching local session directory. A stable
`summary.json` supplies the model and title even when `usage.json` is not
ready. Missing or partial usage stays queued for a later hook or manual replay.

### Kimi Code CLI

From a built checkout, run this inside Kimi (replace the path with your checkout):

```text
/plugins install /absolute/path/to/ohmyc-plugins/plugins/timeline
```

Approve the installation, then start a new session or run `/reload`. Kimi copies
local plugins into its managed directory; reinstall after rebuilding to update
that copy. Node.js 22 or later must be available to the hook process.

Local plugin installation was verified with Kimi Code CLI 2.0.2. Collection and
session resume were verified with 2.1.1 using a local test model endpoint and wire
protocol 1.5. These are tested versions, not claimed minimum versions.

The collector counts started user turns and completed tool attempts, and records
explicit Skill calls or successful `SKILL.md` reads. It sums `usage.record` entries
once, separating cached reads from other input. Missing or wholly invalid usage
stays unavailable; usable usage with malformed records, or sessions containing
subagents, is marked partial. This first
version reads main-agent usage only. Forked sessions exclude inherited activity
before their creation time. Historical sessions are enriched when a native hook
runs; this integration does not perform a bulk history import.

### ZCode (GLM)

From a built checkout, add the local marketplace and install the plugin:

```sh
zcode plugins marketplace add /absolute/path/to/ohmyc-plugins
zcode plugins install timeline@ohmyc
```

Enable hooks in `~/.zcode/cli/config.json` by setting `hooks.enabled` to `true`,
then start a new session. Reinstall or update the plugin after rebuilding the
checkout, because ZCode uses a managed copy. Node.js 22 or later must be available.

Installation, two consecutive turns, and session resume were verified with the
ZCode 0.16.9 CLI bundled in ZCode 3.14.4, using a local test model endpoint. These
are tested versions, not claimed minimum versions or a live GLM service test.

The collector records the host as `zcode` and preserves the native model value
(for example, a GLM model). It joins prompts with completed turns by native
`turnId`, deduplicates completed tool attempts by native tool-call ID, and records
explicit Skill calls or successful `SKILL.md` reads with matching returned paths.
Blocked prompts do not count as completed turns.

ZCode hooks provide no token usage; their temporary transcript contains only the
current prompt or response and disappears after the hook exits. The collector
normalizes the available facts before returning and stores them durably for
replay if the Timeline database is unavailable. Token status stays `unavailable`;
this adapter does not estimate usage or import historical sessions. Collection
begins after installation. The existing default Stop hook is reused once; the
ZCode-specific hook file registers only the other supported events.

Official [ZCode hooks documentation](https://zcode.z.ai/en/docs/hooks) and
[plugin documentation](https://zcode.z.ai/en/docs/plugin).

## Configuration

| Option | Type | Default | Example | Description |
| --- | --- | --- | --- | --- |
| `OHMYC_HOME` | environment variable | `~/.config/ohmyc` | `/tmp/ohmyc` | Directory containing `timeline.db`. |
| `AGENT_HOME` | environment variable | `~/.claude` | `/tmp/.claude` | Claude transcript root used by `ingest-claude.sh`. |
| `CODEX_HOME` | environment variable | `~/.codex` | `/tmp/.codex` | Codex session root used by `ingest-codex.sh`. |
| `GROK_HOME` | environment variable | `~/.grok` | `/tmp/.grok` | Grok session root used for session enrichment. |
| `KIMI_CODE_HOME` | environment variable | `~/.kimi-code` | `/tmp/kimi-code` | Kimi session root used for session enrichment. |

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
