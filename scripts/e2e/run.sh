#!/usr/bin/env bash
# Optional end-to-end check (requires `chromium` in PATH):
#   pnpm build && pnpm test:e2e
#
# Starts the mock LLM on :1234 and headless Chromium on the built single file,
# then drives the real UI over CDP: scan → reachable row → Use →
# Test connection (persists the endpoint). Exits non-zero on any failure.
set -u
cd "$(dirname "$0")/../.."

APP_URL="file://$PWD/dist/page-turn.html#/settings"
MOCK_PID=""
CHROME_PID=""
cleanup() {
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null
}
trap cleanup EXIT

if [ ! -s dist/page-turn.html ]; then
  echo "dist/page-turn.html missing — run 'pnpm build' first." >&2
  exit 1
fi
command -v chromium >/dev/null 2>&1 || {
  echo "chromium not found in PATH — install it to run the e2e check." >&2
  exit 1
}

node scripts/e2e/mock-llm.mjs >/tmp/page-turn-mock.log 2>&1 &
MOCK_PID=$!
sleep 1

chromium --headless --disable-gpu --no-sandbox --remote-debugging-port=9222 \
  --remote-allow-origins='*' "$APP_URL" >/tmp/page-turn-chrome.log 2>&1 &
CHROME_PID=$!
sleep 3

node scripts/e2e/cdp-test.mjs
exit $?
