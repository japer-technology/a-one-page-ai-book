#!/usr/bin/env bash
# Dev-only helper: stop the mock LLM servers and headless chromium started by dev-up.sh.
# Finds the mock servers by the ports they LISTEN on (never by command line, which
# would also match the caller's own shell) and chromium by its throwaway profile:
# the one dev-up last started (recorded in /tmp/pt-profile.current), or the one
# given as an argument.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/_profile.sh"

PROFILE="$(cat /tmp/pt-profile.current 2>/dev/null || true)"
[ -n "$PROFILE" ] || PROFILE="$(pt_default_profile pt-profile)"
if [ "$#" -ge 1 ] && [ -n "${1:-}" ]; then
  PROFILE="$1"
fi

kill_listener() {
  local port="$1"
  local pids
  if ! command -v ss >/dev/null 2>&1; then
    echo "dev-down: 'ss' is unavailable — cannot stop :$port by port" >&2
    return 1
  fi
  pids=$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)
  for pid in $pids; do
    # Never kill by port alone: 1234/11434 are the app's REAL target ports, so
    # a developer's own LM Studio/Ollama must not be stopped by this script.
    if ps -o args= -p "$pid" 2>/dev/null | grep -q 'mock-llm.mjs'; then
      kill "$pid" 2>/dev/null || true
    else
      echo "dev-down: leaving :$port alone — pid $pid is not the e2e mock" >&2
    fi
  done
}

kill_listener 1234 || true
kill_listener 11434 || true
for pid in $(pgrep -f "user-data-dir=${PROFILE}" || true); do kill "$pid" 2>/dev/null || true; done
rm -f /tmp/pt-profile.current
sleep 0.5
# Verify what this script owned is actually gone — 'stopped' must not be a lie.
failed=0
for pid in $(pgrep -f "user-data-dir=${PROFILE}" || true); do
  echo "dev-down: chromium (profile ${PROFILE}) is still running (pid $pid)" >&2
  failed=1
done
if pgrep -f 'mock-llm.mjs' >/dev/null 2>&1; then
  echo "dev-down: a mock-llm process survived" >&2
  failed=1
fi
[ "$failed" = 0 ] || exit 1
echo "stopped"
