#!/usr/bin/env bash
# Dev-only helper: start the mock LLM and a fresh headless chromium on the built app.
#   bash scripts/e2e/dev-up.sh [profile-dir]
# Set PT_MOCK_SERIAL=1 to emulate a single-slot local server (LM Studio default).
set -u
cd "$(dirname "$0")/../.."
PROFILE="${1:-/tmp/pt-profile}"
rm -rf "$PROFILE"
bash scripts/e2e/dev-down.sh >/dev/null
# Record the profile for dev-down, so a non-default one still gets stopped.
echo "$PROFILE" >/tmp/pt-profile.current
nohup node scripts/e2e/mock-llm.mjs >/tmp/pt-mock.log 2>&1 &
sleep 1
nohup chromium --headless --disable-gpu --no-sandbox --remote-debugging-port=9222 \
  --remote-allow-origins='*' --user-data-dir="$PROFILE" \
  "file://$PWD/dist/page-turn.html" >/tmp/pt-chrome.log 2>&1 &
sleep 4
cat /tmp/pt-mock.log
curl -s http://127.0.0.1:9222/json | grep -c webSocketDebuggerUrl
