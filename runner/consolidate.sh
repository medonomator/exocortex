#!/bin/bash
exec "$(dirname "$0")/run-with-alert.sh" "consolidate" npx tsx src/consolidate.ts
