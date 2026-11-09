#!/bin/bash
exec "$(dirname "$0")/run-with-alert.sh" "swarm-analyze" npx tsx src/swarm-analyze.ts --count=7
