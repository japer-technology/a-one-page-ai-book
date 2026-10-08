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
  pids=$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
}

kill_listener 1234
kill_listener 11434
for pid in $(pgrep -f "user-data-dir=${PROFILE}" || true); do kill "$pid" 2>/dev/null || true; done
rm -f /tmp/pt-profile.current
sleep 0.5
echo "stopped"
