#!/bin/bash
# OhMyC Timeline Claude Code Stop Hook — ingests Claude Code session transcripts.
# Calls the bundled node entry at $PLUGIN_ROOT/dist/ingest.mjs or $CLAUDE_PLUGIN_ROOT/dist/ingest.mjs.
# No external CLI binary required.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}}"
INGEST_MJS="$PLUGIN_DIR/dist/ingest.mjs"

export OHMYC_HOME="${OHMYC_HOME:-$HOME/.config/ohmyc}"

log_error() { echo "[timeline] $1" >&2; }
log_info()  { echo "[timeline] $1" >&2; }

# ---------------------------------------------------------------------------
# Resolve node
# ---------------------------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  log_error "node not found on PATH. Cannot ingest session."
  exit 0
fi

if [ ! -f "$INGEST_MJS" ]; then
  log_error "ingest bundle not found at $INGEST_MJS (did you run \`bun run build\`?)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Determine transcript path
# ---------------------------------------------------------------------------

if [ -n "${1:-}" ]; then
  SESSION_ID="$1"
  CLAUDE_HOME="${AGENT_HOME:-$HOME/.claude}"
  TRANSCRIPT_PATH=$(find "$CLAUDE_HOME/projects" -name "${SESSION_ID}.jsonl" -print -quit 2>/dev/null || true)

  if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
    log_error "Transcript not found for session $SESSION_ID"
    exit 0
  fi
else
  HOOK_INPUT=$(cat)
  TRANSCRIPT_PATH=$(HOOK_INPUT="$HOOK_INPUT" node -e '
const input = process.env.HOOK_INPUT || ""
try {
  const parsed = JSON.parse(input)
  console.log(typeof parsed.transcript_path === "string" ? parsed.transcript_path : "")
} catch {
  console.log("")
}
')

  if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
    log_error "No transcript path in hook input or file not found"
    exit 0
  fi

  SESSION_ID=$(basename "$TRANSCRIPT_PATH" .jsonl)
fi

FILE_SIZE=$(stat -f%z "$TRANSCRIPT_PATH" 2>/dev/null || stat -c%s "$TRANSCRIPT_PATH" 2>/dev/null || echo 0)

# ---------------------------------------------------------------------------
# Fast path: jq preprocessing → node --raw via stdin
# ---------------------------------------------------------------------------

if command -v jq >/dev/null 2>&1; then
  log_info "Using jq fast path for session $SESSION_ID"

  set +e
  EXTRACTED=$(jq -s '
    ($transcriptPath | split("/") | .[] | select(. == "projects") as $marker |
      ($transcriptPath | split("/") | index($marker)) as $idx |
      ($transcriptPath | split("/")[($idx + 1):][0]) as $encoded |
      if ($encoded | startswith("-"))
        then ("/" + ($encoded[1:] | gsub("-"; "/")))
        else ($encoded | gsub("-"; "/"))
      end) as $rawProject |
    (($rawProject | startswith($HOME)) as $isHome |
      if $isHome then ("~" + ($rawProject | ltrimstr($HOME))) else $rawProject end) as $project |

    (map(select(.timestamp) | .timestamp | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 * 1000) | min // (now * 1000)) as $startedAt |
    (map(select(.timestamp) | .timestamp | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 * 1000) | max // (now * 1000)) as $endedAt |
    (map(select(.type == "user" and .message.role == "user" and (.message.content | type) == "string") | .message.content) | first) as $firstUserMessage |
    ([.[] | select(.type == "system" and .subtype == "away_summary") | .content] | last) as $awaySummary |

    {
      sessionId: $sessionId,
      project: $project,
      agentName: "claude",
      startedAt: $startedAt,
      endedAt: $endedAt,
      durationMs: ($endedAt - $startedAt),
      turns: ([.[] | select(.type == "user" and .message.role == "user" and (.message.content | type) == "string")] | length),
      tokensInput: ([.[] | select(.type == "assistant" and .message.usage) | .message.usage | if .iterations then (.iterations | map(.input_tokens // 0) | add) else (.input_tokens // 0) end] | add // 0),
      tokensOutput: ([.[] | select(.type == "assistant" and .message.usage) | .message.usage | if .iterations then (.iterations | map(.output_tokens // 0) | add) else (.output_tokens // 0) end] | add // 0),
      tokensCached: ([.[] | select(.type == "assistant" and .message.usage) | .message.usage | if .iterations then (.iterations | map((.cache_read_input_tokens // 0) + (.cache_creation_input_tokens // 0)) | add) else ((.cache_read_input_tokens // 0) + (.cache_creation_input_tokens // 0)) end] | add // 0),
      summary: (if $awaySummary then $awaySummary elif $firstUserMessage then (if ($firstUserMessage | length) > 140 then ($firstUserMessage[:140]) else $firstUserMessage end) else "(untitled session)" end),
      summarySource: (if $awaySummary then "auto" elif $firstUserMessage then "first_message" else "auto" end),
      transcriptPath: $transcriptPath,
      fileSize: ($fileSize | tonumber),
      tools: ([.[] | select(.type == "assistant" and .message.content) | .message.content | arrays[] | select(.type == "tool_use") | .name] | group_by(.) | map({toolName: .[0], callCount: length})),
      skills: ([.[] | select(.type == "assistant" and .message.content) | .message.content | arrays[] | select(.type == "tool_use" and .name == "Skill" and .input.skill) | .input.skill] | unique),
      model: ([.[] | select(.type == "assistant" and .message.model) | .message.model] | last // null)
    }
  ' --arg sessionId "$SESSION_ID" --arg transcriptPath "$TRANSCRIPT_PATH" --arg HOME "$HOME" --arg fileSize "$FILE_SIZE" "$TRANSCRIPT_PATH" 2>/dev/null)
  JQ_STATUS=$?
  set -e

  if [ $JQ_STATUS -eq 0 ] && [ -n "$EXTRACTED" ] && [ "$EXTRACTED" != "null" ]; then
    # `cmd && exit 0` — node failure short-circuits the &&; the chain becomes
    # a conditional context so `set -e` does not exit. Control falls through
    # to the log + slow path below. This is the desired behavior.
    echo "$EXTRACTED" | node --no-warnings "$INGEST_MJS" --raw && exit 0
    log_error "Fast path failed for $SESSION_ID, falling back to slow path"
  else
    log_error "jq extraction failed for $SESSION_ID, falling back to slow path"
  fi
fi

# ---------------------------------------------------------------------------
# Slow path: node parses JSONL itself
# ---------------------------------------------------------------------------

log_info "Using slow path for session $SESSION_ID"
node --no-warnings "$INGEST_MJS" --session-id "$SESSION_ID" --transcript-path "$TRANSCRIPT_PATH" --agent-name claude
