# OhMyC Timeline Plugin

Collects session data from **Claude Code**, **OpenCode**, and **Codex** agents and ingests it into the OhMyC Timeline dashboard.

## Supported Agents

| Agent | Integration | Data Source |
|-------|-------------|-------------|
| Claude Code | Stop hook via `hooks/hooks.json` and `hooks/ingest-claude.sh` | Claude JSONL transcripts in `~/.claude/projects/` |
| Codex | Codex plugin manifest, default `hooks/hooks.json`, and `hooks/ingest-codex.sh` | Codex JSONL sessions in `~/.codex/sessions/` and `~/.codex/archived_sessions/` |
| OpenCode | OpenCode plugin entry at `opencode.ts` | Real-time OpenCode lifecycle, message, and tool events |

## Claude Code Setup

Claude Code reads `.claude-plugin/plugin.json` and `hooks/hooks.json`. The shared Stop hook dispatches Claude sessions to:

```bash
${CLAUDE_PLUGIN_ROOT}/hooks/ingest-claude.sh $CLAUDE_SESSION_ID
```

`ingest-claude.sh` searches `~/.claude/projects/` for the matching transcript and uses the Claude jq fast path when jq is available. If jq is unavailable or the fast path fails, the bundled Node entry at `dist/ingest.mjs` parses the transcript with `--agent-name claude`.

## Codex Setup

Codex discovers the plugin from `.codex-plugin/plugin.json`. Codex plugin lifecycle hooks use the default `hooks/hooks.json`; the shared Stop hook dispatches Codex sessions to:

```bash
${PLUGIN_ROOT}/hooks/ingest-codex.sh
```

`ingest-codex.sh` reads Codex hook input from stdin. It accepts `transcript_path` directly, or searches `~/.codex/sessions/` and `~/.codex/archived_sessions/` by `session_id`. It uses a Codex-specific jq fast path when jq is available, and falls back to the bundled Node parser with `--agent-name codex`; both paths emit the same `ParsedSessionData` shape.

## Node Hook Runtime

The Claude and Codex hook runtime requires Node 22+ and uses Node's built-in `node:sqlite` module. The plugin does not require `better-sqlite3` or a system `sqlite3` command.

## OpenCode Setup

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
