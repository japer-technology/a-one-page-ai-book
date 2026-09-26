#!/usr/bin/env bash
# Dev-only helper: stop the mock LLM servers and headless chromium started by dev-up.sh.
# Finds the mock servers by the ports they LISTEN on (never by command line, which
# would also match the caller's own shell) and chromium by its throwaway profile.
set -u

kill_listener() {
  local port="$1"
  local pids
  pids=$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
}

kill_listener 1234
kill_listener 11434
for pid in $(pgrep -f 'user-data-dir=/tmp/pt-profile' || true); do kill "$pid" 2>/dev/null || true; done
sleep 0.5
echo "stopped"
