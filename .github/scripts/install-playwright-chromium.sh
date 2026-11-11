#!/usr/bin/env bash
# Install the chromium build the browser suite drives, while keeping the apt
# mirror's health out of the job's verdict as far as that stays honest.
#
# 2026-11-11, run 43033222869: all four attempts of the `web` job died in
# `npx playwright install --with-deps chromium` with
#   E: Failed to fetch ... Temporary failure resolving 'azure.archive.ubuntu.com'
# while every step before it passed and the same commit installed the same build
# in 19s two runs earlier (runs 43028098140, 43030604898). Resolving the mirror
# is the runner image's property, not this repository's, so it gets a bounded
# retry and then a browser-only fallback instead of a veto. A dependency that is
# genuinely missing is this repository's problem and has to stay visible: the
# fallback says the system libraries were not installed, and a launch probe turns
# a missing library into a named failure here instead of an unexplained one
# inside the suite.
#
# The variables below exist so the three paths can be rehearsed locally with a
# fake playwright command (see the pull request). CI sets only
# PLAYWRIGHT_CACHE_HIT.
set -uo pipefail

# Every install attempt, including the fallback, is bounded: the 2026-11-11
# attempt spent 10 minutes inside apt before failing, and three of those would
# have overrun the job's own ceiling before the fallback was ever reached. 180s
# is about nine times the 19s a healthy attempt needs.
attempts=${PLAYWRIGHT_INSTALL_ATTEMPTS:-3}
attempt_timeout_s=${PLAYWRIGHT_ATTEMPT_TIMEOUT_S:-180}
backoff_base_s=${PLAYWRIGHT_BACKOFF_BASE_S:-5}
backoff_cap_s=${PLAYWRIGHT_BACKOFF_CAP_S:-60}
IFS=' ' read -r -a playwright_cmd <<< "${PLAYWRIGHT_CMD:-npx playwright}"

log() { printf 'install-playwright: %s\n' "$*"; }

attempt_log=$(mktemp -t playwright-install.XXXXXX)
trap 'rm -f "$attempt_log"' EXIT

# Run one `playwright install ...` into the attempt log, tee'd so the live log
# keeps apt's own output. `timeout` bounds a mirror that hangs instead of
# answering: without it a single attempt can eat the whole job deadline and the
# fallback below would never be reached.
run_install() {
  local status=0
  : > "$attempt_log"
  if command -v timeout >/dev/null 2>&1; then
    timeout --signal=TERM --kill-after=30 "$attempt_timeout_s" \
      "${playwright_cmd[@]}" install "$@" 2>&1 | tee "$attempt_log"
    status=${PIPESTATUS[0]}
  else
    "${playwright_cmd[@]}" install "$@" 2>&1 | tee "$attempt_log"
    status=${PIPESTATUS[0]}
  fi
  return "$status"
}

# One of: mirror, dependency, unknown.
#
# The mirror signatures are checked first on purpose. When the package lists
# cannot be fetched, apt prints `Unable to locate package` as a consequence, so
# matching the dependency signature first would mislabel a DNS outage as our
# packaging bug and skip the retry that fixes it.
classify() {
  local log_file=$1
  if grep -qiE 'Temporary failure (resolving|in name resolution)|Could not resolve|EAI_AGAIN|ENOTFOUND|Network is unreachable|Connection (timed out|refused|failed)|Failed to fetch|Hash Sum mismatch' "$log_file"; then
    printf 'mirror\n'
  elif grep -qiE 'Unable to locate package|no installation candidate|not available, but is referred to|Cannot find module|command not found|not found in PATH' "$log_file"; then
    printf 'dependency\n'
  else
    printf 'unknown\n'
  fi
}

describe() {
  case $1 in
    mirror) printf 'apt mirror / DNS (transient, runner image side)' ;;
    timeout) printf 'attempt exceeded %ss (treated as transient)' "$attempt_timeout_s" ;;
    dependency) printf 'system dependency or tooling (not transient)' ;;
    *) printf 'unclassified (treated as transient)' ;;
  esac
}

show_tail() {
  log 'last 30 lines of the failed attempt:'
  tail -n 30 "$attempt_log" | sed 's/^/    /'
}

attempt=1
cause=unknown
case ${PLAYWRIGHT_CACHE_HIT:-} in
  true) log 'browser binaries restored from the actions/cache entry; --with-deps still runs for the system packages' ;;
  *) log 'no restored browser cache; an attempt that needs to download also downloads the build' ;;
esac
while (( attempt <= attempts )); do
  log "attempt ${attempt}/${attempts}: ${playwright_cmd[*]} install --with-deps chromium (bounded at ${attempt_timeout_s}s)"
  started=$SECONDS
  status=0
  run_install --with-deps chromium || status=$?
  if (( status == 0 )); then
    log "attempt ${attempt}/${attempts}: succeeded after $(( SECONDS - started ))s; chromium and the system packages are installed"
    exit 0
  fi
  cause=$(classify "$attempt_log")
  (( status == 124 )) && cause=timeout
  log "attempt ${attempt}/${attempts}: failed after $(( SECONDS - started ))s with exit ${status}; cause: $(describe "$cause")"
  show_tail

  if (( attempt == attempts )); then
    break
  fi
  if [[ $cause == dependency ]]; then
    # Waiting cannot install a package that is absent from the mirror's lists,
    # and calling it transient would spend the remaining attempts to learn the
    # same thing.
    log 'not retrying: a missing package does not heal by waiting'
    break
  fi
  delay=$(( backoff_base_s * 3 ** (attempt - 1) ))
  (( delay > backoff_cap_s )) && delay=$backoff_cap_s
  log "waiting ${delay}s before the next attempt"
  sleep "$delay"
  attempt=$(( attempt + 1 ))
done

log "no attempt installed the system packages; final cause: $(describe "$cause")"
log 'falling back to a browser-only install: playwright install chromium (no apt, no system dependencies)'
status=0
run_install chromium || status=$?
if (( status != 0 )); then
  log "browser-only install failed with exit ${status}"
  show_tail
  log 'SYSTEM DEPENDENCIES WERE NOT INSTALLED and the browser binary is missing too'
  log 'This is not a mirror blip that a retry would clear: inspect the output above.'
  printf '::error title=Playwright install failed::%s; the browser-only fallback failed as well (exit %s). See the step log for the exact line.\n' \
    "$(describe "$cause")" "$status"
  exit 1
fi

log "browser-only install succeeded; chromium build: $("${playwright_cmd[@]}" --version 2>/dev/null || echo 'version unavailable')"
log 'SYSTEM DEPENDENCIES WERE NOT INSTALLED: the apt step never completed, so the OS packages'
log 'playwright expects are unverified on this runner. If chromium fails to start, the cause is'
log 'the runner image libraries, not this change; check the image and the mirror named above.'

# The browser suite is the gate, so the fallback does not have to guess. A
# single launch says whether the missing apt run actually matters; if it does,
# the failing library is named here instead of surfacing as a spec failure.
log 'probing a chromium launch, since the system dependencies are unverified'
probe_log=$(mktemp -t playwright-probe.XXXXXX)
probe_status=0
node --input-type=module -e 'import { chromium } from "@playwright/test"; const browser = await chromium.launch(); await browser.close();' \
  > "$probe_log" 2>&1 || probe_status=$?
if (( probe_status != 0 )); then
  sed 's/^/    /' "$probe_log"
  rm -f "$probe_log"
  log 'chromium did not launch after the browser-only install'
  log 'The system dependencies are genuinely missing; the browser suite cannot pass in that state.'
  printf '::error title=Playwright system dependencies missing::%s left the system packages uninstalled, and chromium cannot launch without them. The library named above is the actual cause.\n' \
    "$(describe "$cause")"
  exit 1
fi
rm -f "$probe_log"
log 'chromium launched; the runner image already provides the libraries the browser needs'
printf '::warning title=Playwright system dependencies unverified::%s. The browser-only fallback installed chromium and it launches, so the runner image already provides the libraries; the browser suite runs as the gate.\n' \
  "$(describe "$cause")"
