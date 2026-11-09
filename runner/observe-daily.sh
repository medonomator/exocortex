#!/bin/bash
exec "$(dirname "$0")/run-with-alert.sh" "observer-daily" npx tsx src/run-claude.ts --hours=24
