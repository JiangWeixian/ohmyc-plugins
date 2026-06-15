#!/bin/bash
# OhMyC Timeline Codex Stop Hook — ingests Codex session transcripts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="${PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
INGEST_MJS="$PLUGIN_DIR/dist/ingest.mjs"

export OHMYC_HOME="${OHMYC_HOME:-$HOME/.config/ohmyc}"

log_error() { echo "[timeline] $1" >&2; }
log_info()  { echo "[timeline] $1" >&2; }

if ! command -v node >/dev/null 2>&1; then
  log_error "node not found on PATH. Cannot ingest session."
  exit 0
fi

if [ ! -f "$INGEST_MJS" ]; then
  log_error "ingest bundle not found at $INGEST_MJS (did you run \`bun run build\`?)"
  exit 0
fi

HOOK_INPUT=$(cat)
HOOK_FIELDS=$(HOOK_INPUT="$HOOK_INPUT" node -e '
const input = process.env.HOOK_INPUT || ""
try {
  const parsed = JSON.parse(input)
  console.log(JSON.stringify({
    sessionId: typeof parsed.session_id === "string" ? parsed.session_id : "",
    transcriptPath: typeof parsed.transcript_path === "string" ? parsed.transcript_path : "",
  }))
} catch {
  console.log(JSON.stringify({ sessionId: "", transcriptPath: "" }))
}
')
TRANSCRIPT_PATH=$(echo "$HOOK_FIELDS" | node -e 'let b=""; process.stdin.on("data", c => b += c); process.stdin.on("end", () => { try { console.log(JSON.parse(b).transcriptPath || "") } catch { console.log("") } })')
SESSION_ID=$(echo "$HOOK_FIELDS" | node -e 'let b=""; process.stdin.on("data", c => b += c); process.stdin.on("end", () => { try { console.log(JSON.parse(b).sessionId || "") } catch { console.log("") } })')

if [ -z "$TRANSCRIPT_PATH" ] && [ -n "$SESSION_ID" ]; then
  CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
  TRANSCRIPT_PATH=$(find "$CODEX_HOME/sessions" "$CODEX_HOME/archived_sessions" -name "*${SESSION_ID}.jsonl" -print -quit 2>/dev/null || true)
fi

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  log_error "No Codex transcript path in hook input or file not found"
  exit 0
fi

if [ -z "$SESSION_ID" ]; then
  SESSION_ID=$(TRANSCRIPT_PATH="$TRANSCRIPT_PATH" node -e '
const { readFileSync } = require("node:fs")
const transcriptPath = process.env.TRANSCRIPT_PATH || ""
try {
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line.trim()) continue
    const parsed = JSON.parse(line)
    const id = parsed?.type === "session_meta" ? parsed?.payload?.id : undefined
    if (typeof id === "string" && id) {
      console.log(id)
      process.exit(0)
    }
  }
} catch {}
console.log("")
')
fi

if [ -z "$SESSION_ID" ]; then
  SESSION_ID=$(basename "$TRANSCRIPT_PATH" .jsonl)
fi

FILE_SIZE=$(stat -f%z "$TRANSCRIPT_PATH" 2>/dev/null || stat -c%s "$TRANSCRIPT_PATH" 2>/dev/null || echo 0)

if command -v jq >/dev/null 2>&1; then
  log_info "Using jq fast path for Codex session $SESSION_ID"
  set +e
  EXTRACTED=$(jq -s '
    def timestamp_ms:
      capture("^(?<base>[^.]+)(?:\\.(?<frac>[0-9]+))?Z$") as $parts |
      (($parts.base + "Z") | fromdateiso8601 * 1000) +
      (((("0." + ($parts.frac // "0")) | tonumber) * 1000) | floor);
    def display_project($home):
      if startswith($home) then ("~" + ltrimstr($home)) else . end;
    def is_skill_injection:
      (gsub("^\\s+|\\s+$"; "") | startswith("<skill>")) and test("<name>[^<]+</name>") and (gsub("^\\s+|\\s+$"; "") | endswith("</skill>"));
    def command_skill_name:
      select((.payload.name == "exec_command" or .payload.name == "functions.exec_command") and (.payload.arguments | type) == "string")
      | (.payload.arguments | fromjson? | .cmd? // empty)
      | select(type == "string")
      | capture("(^|[\\s\"'\''])\\S*/skills/(?<name>[^/\\s\"'\'']+)/SKILL\\.md([\\s\"'\'']|$)").name;
    def token_usage:
      if (.total_token_usage | type) == "object" then .total_token_usage
      elif (.input_tokens? != null or .output_tokens? != null or .cached_input_tokens? != null) then .
      elif (.last_token_usage | type) == "object" then .last_token_usage
      else {} end;

    (map(select(.timestamp) | .timestamp | timestamp_ms) | min // (now * 1000)) as $startedAt |
    (map(select(.timestamp) | .timestamp | timestamp_ms) | max // (now * 1000)) as $endedAt |
    ([.[] | select(.type == "session_meta" and (.payload.cwd | type) == "string") | .payload.cwd] | last) as $sessionProject |
    ([.[] | select(.type == "turn_context" and (.payload.cwd | type) == "string") | .payload.cwd] | last) as $turnProject |
    ([.[] | select(.type == "turn_context" and (.payload.model | type) == "string") | .payload.model] | last // null) as $model |
    ([.[] | select(.type == "response_item" and .payload.type == "message" and .payload.role == "user") | .payload.content |
      if type == "string" then .
      elif type == "array" then ([.[] | select((.text | type) == "string") | .text] | join("\n"))
      else empty end
    ] | map(select(length > 0))) as $userTexts |
    ($userTexts | map(select(is_skill_injection | not))) as $userMessages |
    (($userTexts | map(select(is_skill_injection) | capture("<name>(?<name>[^<]+)</name>").name)) +
      ([.[] | select(.type == "response_item" and .payload.type == "function_call") | command_skill_name])) as $skillNames |
    ($skillNames | unique) as $skills |
    ([.[] | select(.type == "event_msg" and .payload.type == "token_count" and (.payload.info | type) == "object") | .payload.info | token_usage] | map(select(length > 0)) | last) as $eventUsage |
    ([.[] | select(.type == "turn.completed" and (.usage | type) == "object") | .usage] | map(select(length > 0)) | last) as $turnUsage |
    ($eventUsage // $turnUsage // {}) as $usage |
    {
      sessionId: $sessionId,
      project: (($turnProject // $sessionProject // "unknown") | display_project($HOME)),
      agentName: "codex",
      startedAt: $startedAt,
      endedAt: $endedAt,
      durationMs: ($endedAt - $startedAt),
      turns: ($userMessages | length),
      tokensInput: ($usage.input_tokens // 0),
      tokensOutput: ($usage.output_tokens // 0),
      tokensCached: ($usage.cached_input_tokens // 0),
      summary: (if ($userMessages | length) > 0 then (if ($userMessages[0] | length) > 140 then $userMessages[0][:140] else $userMessages[0] end) else "(untitled session)" end),
      summarySource: (if ($userMessages | length) > 0 then "first_message" else "auto" end),
      transcriptPath: $transcriptPath,
      fileSize: ($fileSize | tonumber),
      tools: ([.[] | select(.type == "response_item" and .payload.type == "function_call" and (.payload.name | type) == "string") | .payload.name] | group_by(.) | map({toolName: .[0], callCount: length})),
      skills: $skills,
      model: $model
    }
  ' --arg sessionId "$SESSION_ID" --arg transcriptPath "$TRANSCRIPT_PATH" --arg HOME "$HOME" --arg fileSize "$FILE_SIZE" "$TRANSCRIPT_PATH" 2>/dev/null)
  JQ_STATUS=$?
  set -e

  if [ $JQ_STATUS -eq 0 ] && [ -n "$EXTRACTED" ] && [ "$EXTRACTED" != "null" ]; then
    echo "$EXTRACTED" | node --no-warnings "$INGEST_MJS" --raw && exit 0
    log_error "Codex jq fast path failed for $SESSION_ID, falling back to slow path"
  else
    log_error "Codex jq extraction failed for $SESSION_ID, falling back to slow path"
  fi
fi

log_info "Using Node parser for Codex session $SESSION_ID"
node --no-warnings "$INGEST_MJS" --session-id "$SESSION_ID" --transcript-path "$TRANSCRIPT_PATH" --agent-name codex
