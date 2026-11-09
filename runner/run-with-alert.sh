#!/bin/bash
# Runs a command and sends a Telegram alert on failure.
# Usage: ./run-with-alert.sh <script-name> <command...>

SCRIPT_NAME="${1:-unknown}"
shift

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

set -a
source "$ROOT_DIR/.env"
set +a

export PATH="${NODE_BIN_DIR:+$NODE_BIN_DIR:}/opt/homebrew/bin:/usr/local/bin:$PATH"
export USER="${USER:-$(id -un)}"
export LOGNAME="${LOGNAME:-$USER}"
export SHELL="${SHELL:-/bin/bash}"
export HOME="${HOME:-$(eval echo "~$USER")}"
if [ -n "${HTTPS_PROXY:-}" ]; then
  export https_proxy="$HTTPS_PROXY"
fi

cd "$ROOT_DIR/runner"

LOG_FILE="/tmp/exocortex-${SCRIPT_NAME}.log"

"$@" >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ] && [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  ERROR_TAIL=$(tail -5 "$LOG_FILE" | head -c 500)
  PAYLOAD=$(jq -n --arg chat_id "$TELEGRAM_CHAT_ID" --arg text "❌ Exocortex [$SCRIPT_NAME] FAILED (exit $EXIT_CODE)

$ERROR_TAIL" '{chat_id: $chat_id, text: $text}')
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    ${https_proxy:+--proxy "$https_proxy"} > /dev/null 2>&1
fi

exit $EXIT_CODE
