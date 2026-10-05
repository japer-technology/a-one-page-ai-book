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

# Wait for OUR fixtures to be ready, and fail fast if they died on startup:
# a leftover mock holding :1234 makes this one exit with EADDRINUSE, and the
# suite used to run anyway against whatever was (or was not) listening.
mock_up=0
for _ in $(seq 1 30); do
  if ! kill -0 "$MOCK_PID" 2>/dev/null; then
    echo "mock-llm exited on startup — is something already listening on :1234?" >&2
    cat /tmp/page-turn-mock.log >&2
    exit 1
  fi
  if (exec 3<>/dev/tcp/127.0.0.1/1234) 2>/dev/null; then mock_up=1; break; fi
  sleep 0.5
done
[ "$mock_up" = 1 ] || {
  echo "mock-llm never opened :1234" >&2
  exit 1
}

chromium --headless --disable-gpu --no-sandbox --remote-debugging-port=9222 \
  --remote-allow-origins='*' "$APP_URL" >/tmp/page-turn-chrome.log 2>&1 &
CHROME_PID=$!

cdp_up=0
for _ in $(seq 1 40); do
  if ! kill -0 "$CHROME_PID" 2>/dev/null; then
    echo "chromium exited on startup — another instance holding :9222 or the profile?" >&2
    tail -5 /tmp/page-turn-chrome.log >&2
    exit 1
  fi
  if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:9222/json/version; then cdp_up=1; break; fi
  sleep 0.5
done
[ "$cdp_up" = 1 ] || {
  echo "chromium CDP never came up on :9222" >&2
  exit 1
}
# And it must be OUR app the debugger is showing: a stale browser holding the
# port answers /json/version too, but serves a different page.
curl -sf http://127.0.0.1:9222/json | grep -q 'page-turn.html' || {
  echo "the CDP endpoint on :9222 is not showing page-turn.html — is a stale browser holding the port?" >&2
  exit 1
}

# `detect-subnet` LAST, deliberately: it has to start a sweep of a range that
# answers nothing (a browser that reveals its own address must be believed
# without probing the network), and a sweep of a dead range is exactly what
# leaves Chromium's network service working through dropped sockets for the next
# few seconds — the app's own troubleshooting notes. Run before the others, it
# made their gateway probes time out and their detection come back empty.
status=0
for script in llm-setup lan-scan cdp-test panel-state seed-cancel detect-subnet; do
  printf '\n──── %s ────\n' "$script"
  node "scripts/e2e/${script}.mjs" || status=1
done
exit $status
