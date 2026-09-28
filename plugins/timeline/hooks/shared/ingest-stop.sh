#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 0
TMP_FILE=$(mktemp "${TMPDIR:-/tmp}/ohmyc-timeline.XXXXXX") || exit 0
trap 'rm -f "$TMP_FILE"' EXIT HUP INT TERM
cat > "$TMP_FILE" || exit 0

HOST=legacy
if command -v node >/dev/null 2>&1; then
  HOST=$(node --no-warnings "$SCRIPT_DIR/../../dist/ingest.mjs" --detect-host < "$TMP_FILE" 2>/dev/null) || HOST=legacy
fi

case "$HOST" in
  cursor|grok)
    "$SCRIPT_DIR/ingest-event.sh" < "$TMP_FILE"
    ;;
  *)
    if [ -n "${PLUGIN_ROOT:-}" ]; then
      "$PLUGIN_ROOT/hooks/ingest-codex.sh" < "$TMP_FILE"
    else
      "$CLAUDE_PLUGIN_ROOT/hooks/ingest-claude.sh" "$CLAUDE_SESSION_ID" < "$TMP_FILE"
    fi
    ;;
esac
exit 0
