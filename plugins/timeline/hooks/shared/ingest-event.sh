#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 0
if ! command -v node >/dev/null 2>&1; then
  echo '[timeline] node is unavailable' >&2
  exit 0
fi
node --no-warnings "$SCRIPT_DIR/../../dist/ingest.mjs" --hook auto ||
  echo '[timeline] collection failed; inspect pending events' >&2
exit 0
