#!/bin/bash
exec "$(dirname "$0")/run-with-alert.sh" "morning-briefing" npx tsx src/morning-briefing.ts
