#!/bin/bash
exec "$(dirname "$0")/run-with-alert.sh" "observer-weekly" npx tsx src/run-claude.ts --hours=168
