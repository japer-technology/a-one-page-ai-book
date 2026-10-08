#!/usr/bin/env bash
# Memory harness: start the mock LLM + a fresh headless chromium (its own CDP
# port 9223) on the built file, run mem-repro.mjs, then clean both up.
#   pnpm build && bash scripts/e2e/mem-repro.sh
set -u
cd "$(dirname "$0")/../.."
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/_profile.sh"

PROFILE="$(pt_default_profile pt-mem-profile)"
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
  echo "chromium not found in PATH — install it to run the memory harness." >&2
  exit 1
}

# A crashed earlier run may still hold the ports/profile; stop those first.
bash scripts/e2e/dev-down.sh "$PROFILE" >/dev/null 2>&1 || true

node scripts/e2e/mock-llm.mjs >/tmp/pt-mem-mock.log 2>&1 &
MOCK_PID=$!
mock_up=0
for _ in $(seq 1 30); do
  if ! kill -0 "$MOCK_PID" 2>/dev/null; then
    echo "mock-llm exited on startup — is something already listening on :1234?" >&2
    cat /tmp/pt-mem-mock.log >&2
    exit 1
  fi
  if (exec 3<>/dev/tcp/127.0.0.1/1234) 2>/dev/null; then mock_up=1; break; fi
  sleep 0.5
done
[ "$mock_up" = 1 ] || {
  echo "mock-llm never opened :1234" >&2
  exit 1
}

rm -rf "$PROFILE"
chromium --headless --disable-gpu --no-sandbox --remote-debugging-port=9223 \
  --remote-allow-origins='*' --user-data-dir="$PROFILE" \
  "file://$PWD/dist/page-turn.html#/settings" >/tmp/pt-mem-chrome.log 2>&1 &
CHROME_PID=$!

cdp_up=0
for _ in $(seq 1 40); do
  if ! kill -0 "$CHROME_PID" 2>/dev/null; then
    echo "chromium exited on startup — another instance holding :9223 or the profile?" >&2
    tail -5 /tmp/pt-mem-chrome.log >&2
    exit 1
  fi
  if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:9223/json/version; then cdp_up=1; break; fi
  sleep 0.5
done
[ "$cdp_up" = 1 ] || {
  echo "chromium CDP never came up on :9223" >&2
  exit 1
}
curl -sf http://127.0.0.1:9223/json | grep -q 'page-turn.html' || {
  echo "the CDP endpoint on :9223 is not showing page-turn.html — is a stale browser holding the port?" >&2
  exit 1
}

node scripts/e2e/mem-repro.mjs
