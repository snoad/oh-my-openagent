#!/usr/bin/env bash
# v2-sandbox.sh - sourced library for an ISOLATED OpenCode 2 sandbox.
#
# Every function is prefixed oqa_v2_. Source it from a sibling script:
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   . "$SCRIPT_DIR/lib/v2-sandbox.sh"
#
# Sourcing this library:
#   - sources lib/common.sh (V1 isolation helpers + oqa_cleanup EXIT trap)
#   - sources lib/v2-versions.sh (the OC2_VERSION pin)
#   - runs v2-bootstrap.sh once (idempotent) so $OC2 exists
#   - installs a chained EXIT trap that stops the sandboxed server and
#     removes every sandbox this process created
#
# SAFETY MODEL (read this):
#   - The sandbox rewrites HOME + all four XDG vars + TMPDIR, so a spawned
#     OC2 host never reads or writes the real ~/.config/opencode,
#     ~/.local/share/opencode or ~/.cache/opencode.
#   - oqa_v2_serve_stop kills the serve launcher AND any opencode process
#     whose environ carries this sandbox's XDG_CONFIG_HOME. OC2 can
#     double-fork a long-lived `serve --service` daemon that outlives the
#     launcher PID; the environ match is what actually reaps it. The match
#     is scoped to the mktemp-unique sandbox path, so the system V1
#     opencode is never matched.
#   - The real HOME is captured at SOURCE time (before any sandbox exists)
#     in OQA_V2_REAL_HOME and is the base for oqa_v2_real_db_digest.
#
# V2 host facts this library relies on (observed on 2.4.1):
#   - config dir: `OC2 debug paths config` -> $XDG_CONFIG_HOME/opencode
#   - log dir:    `OC2 debug paths log`    -> $XDG_DATA_HOME/opencode/log
#   - plugin config shape: {"plugin": ["<absolute-plugin-dir>"]} in
#     <config dir>/opencode.json (plain path strings; resolved internally
#     to {"package": "<dir>"} entries)
#   - serve: plain `OC2 serve --hostname 127.0.0.1 --port <port>` (NEVER
#     --service: that binds the shared managed port 49374)
#   - auth: HTTP Basic, username "opencode", password $OPENCODE_PASSWORD
#   - readiness: GET /api/info returns 200 once up (401 unauthenticated)
#   - plugin list: GET /api/plugin -> {"location": {...}, "data": [{id, ...}]}
#   - log lines: `timestamp=... level=... run=<hex> message="..." role=cli|server`

# shellcheck source=lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
# shellcheck source=lib/v2-versions.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/v2-versions.sh"

OQA_V2_REAL_HOME="$HOME"
OC2_HOME="${OMO_QA_OC2_HOME:-$OQA_V2_REAL_HOME/.cache/omo-qa/opencode-v2/$OC2_VERSION}"
OC2="$OC2_HOME/node_modules/.bin/opencode2"

OQA_V2_SANDBOXES=()
OQA_V2_SANDBOX=""
OQA_V2_SERVER_PID=""
OQA_V2_SERVER_PORT=""
OQA_V2_SERVER_PASS=""
OQA_V2_SERVER_URL=""

oqa_v2_log()  { printf '%s\n' "$*" >&2; }
oqa_v2_pass() { printf 'PASS: %s\n' "$*"; }
oqa_v2_fail() { printf 'FAIL: %s\n' "$*" >&2; return 1; }

# Idempotent bootstrap of the pinned OC2 binary. Pinned via
# OMO_QA_OC2_HOME so the real HOME is used even if called after a sandbox
# rewrote HOME (it must never be, but pin it anyway).
oqa_v2_ensure_binary() {
  if ! command -v bash >/dev/null 2>&1; then
    oqa_v2_log "FAIL: bash missing"; return 1
  fi
  local out rc
  out="$(OMO_QA_OC2_HOME="$OC2_HOME" bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/v2-bootstrap.sh" 2>&1)"
  rc=$?
  printf '%s\n' "$out" >&2
  if [ "$rc" -ne 0 ]; then
    oqa_v2_log "FAIL: v2-bootstrap.sh exited $rc"
    return 1
  fi
  [ -x "$OC2" ] || { oqa_v2_log "FAIL: $OC2 is not executable"; return 1; }
}

oqa_v2_ensure_binary || exit 1

# Create an isolated V2 sandbox. Exports HOME, XDG_CONFIG_HOME, XDG_DATA_HOME,
# XDG_CACHE_HOME, XDG_STATE_HOME, TMPDIR, OPENCODE_DISABLE_AUTOUPDATE=1,
# OPENCODE_DISABLE_MODELS_FETCH=1 and PATH=<sandbox>/bin:$PATH where
# <sandbox>/bin/opencode symlinks to $OC2. Sets OQA_V2_SANDBOX.
#
# IMPORTANT: call this DIRECTLY, never via $(...). Command substitution runs
# in a subshell, which would discard the exports.
oqa_v2_mk_sandbox() {
  local sb
  sb="$(mktemp -d -t oqa-v2-sandbox.XXXXXX)" || return 1
  mkdir -p "$sb/home" "$sb/config" "$sb/data" "$sb/cache" "$sb/state" "$sb/tmp" "$sb/bin" || return 1
  ln -s "$OC2" "$sb/bin/opencode" || return 1
  ln -s "$OC2" "$sb/bin/opencode2" || return 1
  OQA_V2_SANDBOXES+=("$sb")
  export OQA_V2_SANDBOX="$sb"
  export HOME="$sb/home"
  export XDG_CONFIG_HOME="$sb/config"
  export XDG_DATA_HOME="$sb/data"
  export XDG_CACHE_HOME="$sb/cache"
  export XDG_STATE_HOME="$sb/state"
  export TMPDIR="$sb/tmp"
  export OPENCODE_DISABLE_AUTOUPDATE=1
  export OPENCODE_DISABLE_MODELS_FETCH=1
  export PATH="$sb/bin:$PATH"
}

# Remove every sandbox this process created plus any opencode process whose
# environ carries one of those sandbox paths (the OC2 serve daemon).
oqa_v2_rm_sandbox() {
  oqa_v2_serve_stop
  local sb p
  for sb in "${OQA_V2_SANDBOXES[@]:-}"; do
    [ -n "$sb" ] || continue
    for p in $(pgrep -f opencode 2>/dev/null); do
      if oqa_v2_env_matches_sandbox "$p" "$sb"; then
        kill "$p" 2>/dev/null || true
        sleep 0.2
        kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true
      fi
    done
    rm -rf "$sb"
  done
  OQA_V2_SANDBOXES=()
  OQA_V2_SANDBOX=""
}

oqa_v2_env_matches_sandbox() {
  local pid="$1" sb="$2" env_txt
  [ -r "/proc/$pid/environ" ] || return 1
  env_txt="$( { tr '\0' '\n' < "/proc/$pid/environ"; } 2>/dev/null )" || return 1
  printf '%s\n' "$env_txt" | grep -q "^XDG_CONFIG_HOME=$sb/config$"
}

# Absolute path of the sandboxed V2 config dir (from `OC2 debug paths config`).
oqa_v2_config_path() {
  [ -n "$OQA_V2_SANDBOX" ] || { oqa_v2_log "FAIL: no sandbox (call oqa_v2_mk_sandbox first)"; return 1; }
  "$OC2" debug paths config 2>/dev/null | tail -1
}

# Write the plugin config so the sandboxed V2 host loads <plugin-dir> as a
# local plugin package: {"plugin": ["<plugin-dir>"]}.
oqa_v2_write_plugin_config() {
  local plugin_dir="$1" cfg_dir cfg_file
  [ -d "$plugin_dir" ] || { oqa_v2_log "FAIL: plugin dir not found: $plugin_dir"; return 1; }
  cfg_dir="$(oqa_v2_config_path)" || return 1
  mkdir -p "$cfg_dir" || return 1
  cfg_file="$cfg_dir/opencode.json"
  printf '{"plugin":["%s"]}\n' "$plugin_dir" > "$cfg_file" || return 1
  oqa_v2_log "wrote plugin config: $cfg_file -> $plugin_dir"
}

# Print a free TCP port on 127.0.0.1.
oqa_v2_find_free_port() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
  else
    printf '%s' "$(( (RANDOM % 20000) + 40000 ))"
  fi
}

# Start the sandboxed V2 server. Plain `serve` (never --service: the managed
# port 49374 is shared across runs). Sets OQA_V2_SERVER_PID / _PORT / _PASS /
# _URL. Honors OQA_V2_PORT (port-conflict QA) and OPENCODE_PASSWORD.
# The server runs from the sandbox TMPDIR so no project config is picked up.
oqa_v2_serve_start() {
  [ -n "$OQA_V2_SANDBOX" ] || { oqa_v2_log "FAIL: no sandbox (call oqa_v2_mk_sandbox first)"; return 1; }
  [ -z "$OQA_V2_SERVER_PID" ] || { oqa_v2_log "FAIL: server already running (pid $OQA_V2_SERVER_PID)"; return 1; }
  local port pass
  port="${OQA_V2_PORT:-$(oqa_v2_find_free_port)}"
  if [ -n "${OPENCODE_PASSWORD:-}" ]; then
    pass="$OPENCODE_PASSWORD"
  else
    pass="oqa-${RANDOM}${RANDOM}"
  fi
  mkdir -p "$OQA_V2_SANDBOX/tmp"
  (cd "$OQA_V2_SANDBOX/tmp" && OPENCODE_PASSWORD="$pass" exec "$OC2" serve \
      --hostname 127.0.0.1 --port "$port" \
      > "$OQA_V2_SANDBOX/serve.out" 2>&1 < /dev/null) &
  OQA_V2_SERVER_PID=$!
  disown "$OQA_V2_SERVER_PID" 2>/dev/null || true
  OQA_V2_SERVER_PORT="$port"
  OQA_V2_SERVER_PASS="$pass"
  OQA_V2_SERVER_URL="http://127.0.0.1:$port"
  oqa_v2_log "serve started: pid=$OQA_V2_SERVER_PID url=$OQA_V2_SERVER_URL"
}

# Stop the sandboxed V2 server: kill the launcher tree, then any opencode
# process whose environ is tagged with ANY sandbox this process created.
oqa_v2_serve_stop() {
  if [ -n "$OQA_V2_SERVER_PID" ]; then
    kill "$OQA_V2_SERVER_PID" 2>/dev/null || true
    sleep 0.3
    kill -0 "$OQA_V2_SERVER_PID" 2>/dev/null && kill -9 "$OQA_V2_SERVER_PID" 2>/dev/null || true
  fi
  local sb p
  for sb in "${OQA_V2_SANDBOXES[@]:-}"; do
    [ -n "$sb" ] || continue
    for p in $(pgrep -f opencode 2>/dev/null); do
      if oqa_v2_env_matches_sandbox "$p" "$sb"; then
        kill "$p" 2>/dev/null || true
        sleep 0.2
        kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true
      fi
    done
  done
  OQA_V2_SERVER_PID=""
}

# Poll GET /api/info until it answers 200 (authenticated). Bails early when
# the serve launcher died (fast failure on port conflicts).
oqa_v2_wait_ready() {
  local timeout="${1:-30}" deadline code
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -u "opencode:$OQA_V2_SERVER_PASS" "$OQA_V2_SERVER_URL/api/info" 2>/dev/null)"
    [ "$code" = "200" ] && return 0
    if ! kill -0 "$OQA_V2_SERVER_PID" 2>/dev/null; then
      [ "$code" = "200" ] && return 0
      oqa_v2_log "serve process died before becoming ready (see $OQA_V2_SANDBOX/serve.out)"
      return 1
    fi
    sleep 0.5
  done
  return 1
}

# Poll GET /api/plugin until <id> appears in the data list.
oqa_v2_wait_plugin() {
  local want_id="$1" timeout="${2:-60}" deadline resp
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    resp="$(oqa_v2_api GET /api/plugin 2>/dev/null)" || resp=""
    if printf '%s' "$resp" | jq -e --arg id "$want_id" '.data[] | select(.id == $id)' >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$OQA_V2_SERVER_PID" 2>/dev/null; then
      oqa_v2_log "serve process died while waiting for plugin '$want_id'"
      return 1
    fi
    sleep 1
  done
  return 1
}

# Authenticated API call. Auth scheme: HTTP Basic, username "opencode",
# password $OPENCODE_PASSWORD (observed: 401 {"_tag":"UnauthorizedError"}
# without credentials, 200 with -u opencode:$OPENCODE_PASSWORD).
oqa_v2_api() {
  local method="$1" path="$2"
  curl -s -m 30 -X "$method" -u "opencode:$OQA_V2_SERVER_PASS" "$OQA_V2_SERVER_URL$path"
}

# Absolute path of the sandboxed V2 log dir (from `OC2 debug paths log`).
# The log file itself is <dir>/opencode.log.
oqa_v2_log_path() {
  [ -n "$OQA_V2_SANDBOX" ] || { oqa_v2_log "FAIL: no sandbox (call oqa_v2_mk_sandbox first)"; return 1; }
  "$OC2" debug paths log 2>/dev/null | tail -1
}

# Digest of the REAL opencode DB: "<sha256> sessions=<count>" (or "missing").
# Never opens the DB for writing; sqlite3 is read-only here.
oqa_v2_real_db_digest() {
  local db="$OQA_V2_REAL_HOME/.local/share/opencode/opencode.db"
  if [ ! -f "$db" ]; then
    printf 'missing'
    return 0
  fi
  local digest sessions
  digest="$(sha256sum "$db" 2>/dev/null | cut -d' ' -f1)"
  sessions="$(sqlite3 "$db" 'SELECT count(*) FROM session' 2>/dev/null || printf '?')"
  printf '%s sessions=%s' "$digest" "${sessions:-?}"
}

# Full teardown. Chained after oqa_cleanup (from common.sh) in the EXIT trap.
oqa_v2_teardown() {
  oqa_v2_rm_sandbox
  oqa_cleanup
}
trap oqa_v2_teardown EXIT

# ---- self-check ------------------------------------------------------------
# Run: bash scripts/lib/v2-sandbox.sh --self-test
# (--self-test, not --self-check: common.sh reacts to --self-check at source
# time and would run its own self-check instead.)
oqa_v2__self_check() {
  local fails=0
  oqa_require "$OC2" curl jq sqlite3 || { oqa_v2_log "FAIL: missing dependencies"; return 1; }

  local sb marker home cfg port
  marker="$(mktemp -t oqa-v2-marker.XXXXXX)"
  bash -c '
    . "'"${BASH_SOURCE[0]}"'"
    oqa_v2_mk_sandbox
    printf "%s\n%s\n%s\n" "$OQA_V2_SANDBOX" "$HOME" "$(oqa_v2_config_path)" > "'"$marker"'"
  ' || fails=$((fails+1))
  sb="$(sed -n '1p' "$marker" 2>/dev/null)"
  home="$(sed -n '2p' "$marker" 2>/dev/null)"
  cfg="$(sed -n '3p' "$marker" 2>/dev/null)"
  rm -f "$marker"
  if [ -n "$sb" ] && [ ! -d "$sb" ]; then
    oqa_v2_pass "sandbox auto-removed on exit ($sb)"
  else
    oqa_v2_log "FAIL: sandbox not cleaned: '$sb'"; fails=$((fails+1))
  fi
  if [ "$home" = "$sb/home" ]; then
    oqa_v2_pass "sandbox HOME points inside the sandbox"
  else
    oqa_v2_log "FAIL: HOME='$home' sandbox='$sb'"; fails=$((fails+1))
  fi
  if [ "$cfg" = "$sb/config/opencode" ]; then
    oqa_v2_pass "oqa_v2_config_path -> $cfg"
  else
    oqa_v2_log "FAIL: oqa_v2_config_path -> '$cfg'"; fails=$((fails+1))
  fi

  port="$(oqa_v2_find_free_port)"
  if [ "$port" -gt 0 ] 2>/dev/null; then
    oqa_v2_pass "oqa_v2_find_free_port -> $port"
  else
    oqa_v2_log "FAIL: oqa_v2_find_free_port -> '$port'"; fails=$((fails+1))
  fi

  local dbd
  dbd="$(oqa_v2_real_db_digest)"
  if printf '%s' "$dbd" | grep -Eq '^[0-9a-f]{64} sessions=[0-9?]+$|^missing$'; then
    oqa_v2_pass "oqa_v2_real_db_digest -> $dbd"
  else
    oqa_v2_log "FAIL: oqa_v2_real_db_digest -> '$dbd'"; fails=$((fails+1))
  fi

  local sys_cmd
  sys_cmd="$(command -v opencode)"
  if [ "$sys_cmd" != "$OQA_V2_SANDBOX/bin/opencode" ]; then
    oqa_v2_pass "system opencode still resolves first ($sys_cmd)"
  else
    oqa_v2_log "FAIL: sandbox leaked into PATH resolution"; fails=$((fails+1))
  fi

  if [ "$fails" -eq 0 ]; then
    oqa_v2_pass "v2-sandbox self-check"
    return 0
  fi
  oqa_v2_log "v2-sandbox self-check had $fails failure(s)"
  return 1
}

# Direct execution only: when sourced, ${BASH_SOURCE[0]} != $0 and a caller's
# inherited $1 (e.g. `v2-plugin-probe.sh --self-test`) must NOT fire this
# guard at source time - it would run the library self-check and exit before
# the caller's own dispatch.
if [ "${BASH_SOURCE[0]}" = "$0" ] && [ "${1:-}" = "--self-test" ]; then
  oqa_v2__self_check
  exit $?
fi
