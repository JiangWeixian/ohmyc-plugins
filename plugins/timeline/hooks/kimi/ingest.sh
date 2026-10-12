#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 0
exec "$SCRIPT_DIR/../shared/ingest-event.sh" "$@"
