#!/usr/bin/env bash
# Sourced helper: pick a Chromium profile directory that BOTH the browser AND
# this host can use.
#
# Snap chromium runs its own private /tmp (a bind-mount the host cannot see
# into), so a profile passed as /tmp/... lives only inside the snap: the
# host's `rm -rf` silently fails, and "start a fresh profile" quietly becomes
# "reuse every earlier run's shelf" — state (IndexedDB: every book, every
# setting) accumulates forever. The snap's own home directory is visible here
# and writable in there.
#
# Usage:  . scripts/e2e/_profile.sh;  PROFILE="$(pt_default_profile pt-profile)"
# PT_PROFILE overrides entirely (used by CI and power users).
pt_default_profile() {
  local suffix="${1:-pt-profile}"
  if [ -n "${PT_PROFILE:-}" ]; then
    printf '%s' "$PT_PROFILE"
    return
  fi
  if [ -d "${HOME:-}/snap/chromium" ]; then
    printf '%s' "$HOME/snap/chromium/common/$suffix"
  else
    printf '%s' "/tmp/$suffix"
  fi
}
