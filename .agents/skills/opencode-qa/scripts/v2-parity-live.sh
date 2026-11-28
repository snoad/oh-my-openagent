#!/usr/bin/env bash
# v2-parity-live.sh - drive the live OpenCode 2 parity rows (plan task 20).
#
# Flow: verify $OC2 and its version (fail fast with the bootstrap command),
# run `bun run build` unless --no-build, create the isolated sandbox with the
# plugin equal to the repo root, start the scenario fake model and the
# sandboxed server, drive scenarios A (plain text), B (read tool), C (shell
# cat) plus a second-location session and a minimal TUI smoke, run the live
# runner (V2/parity/live-runner.ts) against the live surfaces, trigger the
# plugin reload so the previous runtimes stop and emit their "[opencode-v2]
# event stats " lines (the host hard-exits at shutdown and never runs plugin
# cleanup), stop the server, copy serve.out and the plugin file log AFTER
# shutdown, run the post phase (L-15 plus the cleanup-stats halves of L-11
# and L-24), then run v2-v1-regression.sh (L-18) unless --skip-v1 and write
# its verdict into results.json. Prints the result table; the final line never claims "every
# executed live row passed" while a partial, stop or pending row of wave <= N
# exists (every open row is named with its owner). Exit 0 when no row FAILED
# and the strict gate is satisfied.
#
# Isolation is leak-based: unrelated sessions other processes create in the
# real opencode.db during the run are recorded as ambient and never fail a
# row; a real leak (a session row whose directory lies inside the sandbox, a
# sandbox directory left behind, or a changed system opencode --version) FAILs.
# When no system opencode is installed at all (CI runners), the manifest
# records systemOpencode "absent" with null versions and the version clause
# is not applicable; every leak-based clause still applies.
#
# System dependencies: bash, bun + node (build + runner), curl, jq, sqlite3,
# git, tmux, plus the OC2 binary bootstrapped by v2-bootstrap.sh. The CI job
# of plan task 21 installs only tmux and jq on ubuntu-latest; curl, git,
# sqlite3 and node are preinstalled there and bun comes from the setup action.
#
# Usage:
#   v2-parity-live.sh --wave <n> [--ci] [--strict] [--skip-v1] [--self-test] [--no-build]
#                     [--recapture-v1-baseline]
#   --strict: exit non-zero when any selected row (wave <= N) is partial,
#             stop or pending (later wave gates use it; the wave-2 gate does
#             not).
#   --recapture-v1-baseline: BEFORE the sandbox is created, re-run
#             v2-v1-baseline.sh so the committed V1 fixtures are recaptured
#             on the machine the run executes on (V1 agent prompts embed
#             environment-derived content: the omo-model-core workstation
#             block and the timezone; the committed fixtures are an artifact
#             of one machine, so byte equality between the V1 and V2 prompts
#             is only meaningful when both captures come from the same
#             machine). The CI workflow passes the switch explicitly; local
#             runs keep the committed fixtures. The capture log lands in the
#             evidence dir (v1-baseline-recapture.out); a failed capture
#             fails the run fast with the log tail.
#
# Env:
#   OQA_V2_PLUGIN_DIR   plugin dir under test (default: the repo root; the
#                       failure QA points it at a broken plugin)
#   OQA_V2_PORT         force the serve port
#   OQA_V2_OUT          evidence dir (default: .omo/evidence/<date>-opencode-v2-compat/task-20/live)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
RUNNER="$REPO_ROOT/packages/omo-opencode/src/opencode-v2/parity/live-runner.ts"

WAVE=""
CI=0
STRICT=0
STRICT_FLAG=""
SKIP_V1=0
SELF_TEST=0
NO_BUILD=0
RECAPTURE_V1_BASELINE=0
EV_LIVE=""

oqa_pl_log()  { printf '[v2-parity-live] %s\n' "$*" >&2; }
oqa_pl_pass() { printf 'PASS: %s\n' "$*"; }
oqa_pl_fail() { printf 'FAIL: %s\n' "$*" >&2; FAILS=$((FAILS + 1)); return 1; }
FAILS=0

# ---- env restore (the bun/ junk root-cause fix) ----------------------------
# bun resolves its transpile cache as pathJoin(XDG_CACHE_HOME, "bun"); an
# EMPTY string yields the relative path "bun", so any bun process whose cwd
# is the repo root writes ./bun/@t@/*.pile into the repo. The restore below
# therefore preserves SET/UNSET state per var instead of exporting "".

OQA_PL_REAL_HOME="$HOME"
OQA_PL_REAL_PATH="$PATH"
OQA_PL_REAL_TMPDIR="${TMPDIR:-/tmp}"
OQA_PL_XDG_CONFIG_WAS_SET=0; OQA_PL_REAL_XDG_CONFIG=""
OQA_PL_XDG_DATA_WAS_SET=0;   OQA_PL_REAL_XDG_DATA=""
OQA_PL_XDG_CACHE_WAS_SET=0;  OQA_PL_REAL_XDG_CACHE=""
OQA_PL_XDG_STATE_WAS_SET=0;  OQA_PL_REAL_XDG_STATE=""

oqa_pl_capture_real_env() {
  OQA_PL_REAL_HOME="$HOME"
  OQA_PL_REAL_PATH="$PATH"
  OQA_PL_REAL_TMPDIR="${TMPDIR:-/tmp}"
  if [ "${XDG_CONFIG_HOME+set}" = "set" ]; then OQA_PL_XDG_CONFIG_WAS_SET=1; OQA_PL_REAL_XDG_CONFIG="$XDG_CONFIG_HOME"; fi
  if [ "${XDG_DATA_HOME+set}" = "set" ]; then OQA_PL_XDG_DATA_WAS_SET=1; OQA_PL_REAL_XDG_DATA="$XDG_DATA_HOME"; fi
  if [ "${XDG_CACHE_HOME+set}" = "set" ]; then OQA_PL_XDG_CACHE_WAS_SET=1; OQA_PL_REAL_XDG_CACHE="$XDG_CACHE_HOME"; fi
  if [ "${XDG_STATE_HOME+set}" = "set" ]; then OQA_PL_XDG_STATE_WAS_SET=1; OQA_PL_REAL_XDG_STATE="$XDG_STATE_HOME"; fi
}

oqa_pl_restore_real_env() {
  export HOME="$OQA_PL_REAL_HOME"
  export TMPDIR="$OQA_PL_REAL_TMPDIR"
  if [ "$OQA_PL_XDG_CONFIG_WAS_SET" = "1" ]; then export XDG_CONFIG_HOME="$OQA_PL_REAL_XDG_CONFIG"; else unset XDG_CONFIG_HOME; fi
  if [ "$OQA_PL_XDG_DATA_WAS_SET" = "1" ]; then export XDG_DATA_HOME="$OQA_PL_REAL_XDG_DATA"; else unset XDG_DATA_HOME; fi
  if [ "$OQA_PL_XDG_CACHE_WAS_SET" = "1" ]; then export XDG_CACHE_HOME="$OQA_PL_REAL_XDG_CACHE"; else unset XDG_CACHE_HOME; fi
  if [ "$OQA_PL_XDG_STATE_WAS_SET" = "1" ]; then export XDG_STATE_HOME="$OQA_PL_REAL_XDG_STATE"; else unset XDG_STATE_HOME; fi
}

# ---- real-DB leak analysis --------------------------------------------------

oqa_pl_dump_db_sessions() {
  # "<id>|<directory>" rows of the real DB (read-only). Missing DB -> empty.
  local db="$OQA_V2_REAL_HOME/.local/share/opencode/opencode.db" out="$1"
  if [ -f "$db" ]; then
    sqlite3 "$db" "SELECT id || '|' || COALESCE(directory,'') FROM session" 2>/dev/null > "$out" || : > "$out"
  else
    : > "$out"
  fi
}

oqa_pl_json_string_array() { jq -Rn '[inputs]' < "$1" 2>/dev/null || printf '[]'; }

oqa_pl_analyze_db_sessions() {
  # leak = a NEW session row whose directory is inside the sandbox;
  # ambient = every other new row (recorded, never gating).
  local sandbox="$1"
  awk -F'|' 'NR==FNR { seen[$1] = 1; next } !($1 in seen)' \
    "$WORK_DIR/db-before.txt" "$WORK_DIR/db-after.txt" > "$WORK_DIR/db-new.txt"
  awk -F'|' -v sb="$sandbox" 'index($2, sb "/") == 1 || $2 == sb { print $2 }' \
    "$WORK_DIR/db-new.txt" > "$WORK_DIR/leak-dirs.txt"
  awk -F'|' -v sb="$sandbox" 'index($2, sb "/") != 1 && $2 != sb { print $2 }' \
    "$WORK_DIR/db-new.txt" > "$WORK_DIR/ambient-dirs.txt"
}

session_count_of() {
  local count
  count="$(printf '%s' "$1" | sed -n 's/.*sessions=\([0-9?]*\)$/\1/p')"
  printf '%s' "${count:--1}"
}

# ---- result table, strict gate, L-18 verdict, bun/ guard --------------------

oqa_pl_verdict_of() {
  jq -r --arg row "$1" '.[] | select(.row == $row) | .pass |
    if . == true then "PASS" elif . == false then "FAIL" elif . == "partial" then "PARTIAL"
    elif . == "stop" then "STOP" else "PENDING" end' "$EV_LIVE/results.json" 2>/dev/null | head -1
}

oqa_pl_print_table() {
  local results="$EV_LIVE/results.json"
  [ -f "$results" ] || { oqa_pl_log "no results.json at $results"; return 1; }
  printf '%s\n' "---- live parity result table (wave $WAVE) ----"
  jq -r 'sort_by(.row)[] | "\(.pass |
    if . == true then "PASS" elif . == false then "FAIL" elif . == "partial" then "PARTIAL"
    elif . == "stop" then "STOP" else "PENDING" end)  \(.row)  \(.summary)"' "$results"
  printf '%s\n' "--------------------------------------------------"
  local fails open_list
  fails="$(jq '[.[] | select(.pass == false)] | length' "$results")"
  if [ "${fails:-0}" -gt 0 ]; then
    oqa_pl_fail "$fails live row(s) FAILED"
    return 1
  fi
  open_list="$(jq -r --argjson w "$WAVE" '[
    .[] | select((.wave // 99) <= $w and (.pass != true and .pass != false)) |
    "\(.pass) \(.row) owner: \(.owner // "UNNAMED")"
  ] | join("; ")' "$results")"
  if [ -n "$open_list" ]; then
    printf 'OPEN ROWS REMAIN (wave <= %s): %s\n' "$WAVE" "$open_list"
    printf '%s\n' "DONE: no row FAILED; open rows remain and are named above with their owners"
    return 0
  fi
  oqa_pl_pass "every executed live row passed"
}

oqa_pl_strict_gate() {
  [ "$STRICT" -eq 1 ] || return 0
  local open
  open="$(jq -r --argjson w "$WAVE" \
    '[.[] | select((.wave // 99) <= $w and (.pass != true and .pass != false))] | length' \
    "$EV_LIVE/results.json" 2>/dev/null || printf '0')"
  if [ "${open:-0}" -gt 0 ]; then
    oqa_pl_log "strict gate: $open open row(s) (partial/stop/pending) at wave <= $WAVE"
    return 1
  fi
  return 0
}

oqa_pl_apply_v1_verdict() {
  local out="$1" verdict tmp bool summary
  verdict="$(grep -oE '^L-18 (PASS|FAIL):' "$out" 2>/dev/null | head -1)"
  if [ -z "$verdict" ]; then
    oqa_pl_log "no L-18 verdict line found in $out; L-18 stays pending with its owner named"
    return 1
  fi
  bool=true
  summary="V1 regression verdict (v2-v1-regression.sh): PASS"
  case "$verdict" in
    *FAIL*) bool=false; summary="V1 regression verdict (v2-v1-regression.sh): FAIL" ;;
  esac
  tmp="$EV_LIVE/results.json.l18.tmp"
  jq --argjson pass "$bool" --arg summary "$summary" --arg evidence "$out" \
    'map(if .row == "L-18" then .pass = $pass | .summary = $summary | .evidence = $evidence else . end)' \
    "$EV_LIVE/results.json" > "$tmp" && mv "$tmp" "$EV_LIVE/results.json"
}

oqa_pl_bun_junk_check() {
  if [ "$REPO_BUN_DIR_BEFORE" = "0" ] && [ -d "$REPO_ROOT/bun" ]; then
    oqa_pl_log "junk listing: $(find "$REPO_ROOT/bun" -type f 2>/dev/null | wc -l) files under $REPO_ROOT/bun"
    oqa_pl_fail "a bun/ directory appeared under the repo root during the run ($REPO_ROOT/bun); a non-restored sandbox env leaked bun's relative cache dir"
    return 1
  fi
  return 0
}

# ---- OC2 verification (fail fast with the bootstrap command) --------------
oqa_pl_verify_oc2() {
  local ver
  [ -x "$OC2" ] || {
    oqa_pl_fail "OC2 binary missing at $OC2; bootstrap it first:"
    printf '  bash .agents/skills/opencode-qa/scripts/v2-bootstrap.sh\n' >&2
    return 1
  }
  ver="$("$OC2" --version 2>/dev/null | tail -1 | sed 's/^[^0-9]*//')"
  if [ "$ver" != "$OC2_VERSION" ]; then
    oqa_pl_fail "OC2 version mismatch: $OC2 reports '${ver:-none}', pin is $OC2_VERSION; re-bootstrap:"
    printf '  bash .agents/skills/opencode-qa/scripts/v2-bootstrap.sh\n' >&2
    return 1
  fi
  oqa_pl_pass "OC2 $OC2_VERSION verified at $OC2"
}

# ---- V1 baseline recapture ---------------------------------------------------
# The committed v1-baseline fixtures were captured on one machine; V1 agent
# prompts embed environment-derived content (the omo-model-core workstation
# block, the timezone), so L-03's byte equality is only meaningful when the
# V1 and V2 captures come from the same machine. With the switch the capture
# runs BEFORE the driver sandbox is created (it owns its own isolated XDG via
# lib/common.sh). OQA_PL_V1_BASELINE_SCRIPT overrides the capture script so
# the self-test can stub it (no V1 host needed in import mode).
oqa_pl_recapture_v1_baseline() {
  [ "$RECAPTURE_V1_BASELINE" -eq 1 ] || return 0
  . "$SCRIPT_DIR/lib/v2-versions.sh"
  local script="${OQA_PL_V1_BASELINE_SCRIPT:-$SCRIPT_DIR/v2-v1-baseline.sh}" log rc
  oqa_pl_log "recapturing the V1 agent baseline on the pinned V1 host $V1_VERSION (the committed fixtures are an artifact of one machine)"
  mkdir -p "$EV_LIVE"
  log="$EV_LIVE/v1-baseline-recapture.out"
  bash "$script" > "$log" 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then
    oqa_pl_log "V1 baseline recapture failed (rc=$rc); log tail follows"
    tail -n 20 "$log" >&2 2>/dev/null || true
    oqa_pl_fail "V1 baseline recapture failed; full log: $log"
    return 1
  fi
  oqa_pl_pass "V1 baseline recaptured on host $V1_VERSION (log: $log)"
}

# ---- fake model control ----------------------------------------------------

FAKE_PID=""
FAKE_PORT=""

oqa_pl_start_fake() {
  local scenario="$1" out="$2"
  if [ -n "$FAKE_PID" ]; then
    kill "$FAKE_PID" 2>/dev/null || true
    sleep 0.5
    kill -0 "$FAKE_PID" 2>/dev/null && kill -9 "$FAKE_PID" 2>/dev/null || true
    FAKE_PID=""
  fi
  for i in $(seq 1 10); do
    curl -sf -m 2 "http://127.0.0.1:$FAKE_PORT/health" >/dev/null 2>&1 || break
    sleep 0.3
  done
  OQA_V2_FAKE_PORT="$FAKE_PORT" OQA_V2_FAKE_MODE=scenario \
    OQA_V2_FAKE_SCENARIO="$scenario" OQA_V2_FAKE_OUT="$out" \
    node "$SCRIPT_DIR/lib/v2-fake-model.mjs" > "$WORK_DIR/fake-$(basename "$out").out" 2>&1 &
  FAKE_PID=$!
  local i
  for i in $(seq 1 40); do
    curl -sf -m 2 "http://127.0.0.1:$FAKE_PORT/health" >/dev/null 2>&1 && return 0
    kill -0 "$FAKE_PID" 2>/dev/null || { oqa_pl_log "fake model died"; cat "$WORK_DIR/fake-$(basename "$out").out" >&2; return 1; }
    sleep 0.25
  done
  oqa_pl_log "fake model never answered /health"
  return 1
}

# ---- scenario runs ---------------------------------------------------------

EVT_PID=""

oqa_pl_stop_evt() {
  if [ -n "$EVT_PID" ]; then
    kill "$EVT_PID" 2>/dev/null || true
    EVT_PID=""
  fi
}

# Drives one OC2 run and records the session id + SSE capture.
# Args: <key> <title> <prompt> <proj-dir>; sets OQA_PL_SID
oqa_pl_run_once() {
  local key="$1" title="$2" prompt="$3" proj="$4"
  oqa_pl_stop_evt
  rm -f "$WORK_DIR/$key.events.sse" "$WORK_DIR/$key.run.json" "$WORK_DIR/$key.run.err"
  ( curl -s -m 300 -N -u "opencode:$OQA_V2_SERVER_PASS" \
      "$OQA_V2_SERVER_URL/api/event" > "$WORK_DIR/$key.events.sse" 2>/dev/null ) &
  EVT_PID=$!
  ( cd "$proj" && OPENCODE_PASSWORD="$OQA_V2_SERVER_PASS" timeout 180 "$OC2" run "$prompt" \
      --title "$title" --format json --server "$OQA_V2_SERVER_URL" ) \
    > "$WORK_DIR/$key.run.json" 2> "$WORK_DIR/$key.run.err"
  local rc=$?
  sleep 2
  oqa_pl_stop_evt
  OQA_PL_SID="$(jq -r 'select(.sessionID != null) | .sessionID' "$WORK_DIR/$key.run.json" 2>/dev/null | head -1)"
  if [ -z "${OQA_PL_SID:-}" ]; then
    OQA_PL_SID="$(grep '^data: ' "$WORK_DIR/$key.events.sse" 2>/dev/null | sed 's/^data: //' \
      | jq -r 'select(.type == "session.created") | .data.sessionID' 2>/dev/null | tail -1)"
  fi
  oqa_pl_log "run '$key' rc=$rc sid=${OQA_PL_SID:-none}"
  [ "$rc" -eq 0 ] && [ -n "${OQA_PL_SID:-}" ]
}

# ---- minimal V2 TUI smoke under tmux ---------------------------------------

oqa_pl_tui_smoke() {
  local sess cap found="" i
  sess="oqa_pl_${$}_${RANDOM}"
  TUI_SESSIONS+=("$sess")
  tmux new-session -d -s "$sess" -x 200 -y 50
  tmux send-keys -t "$sess" \
    "HOME='$HOME' XDG_DATA_HOME='$XDG_DATA_HOME' XDG_CONFIG_HOME='$XDG_CONFIG_HOME' XDG_CACHE_HOME='$XDG_CACHE_HOME' XDG_STATE_HOME='$XDG_STATE_HOME' TMPDIR='$TMPDIR' OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 '$OQA_V2_SANDBOX/bin/opencode' '$PROJ_DIR'" Enter
  for i in $(seq 1 30); do
    cap="$(tmux capture-pane -t "$sess" -p 2>/dev/null)"
    if printf '%s' "$cap" | grep -Eq "Ask anything|ctrl\+p|agents|opencode"; then found=1; break; fi
    sleep 0.5
  done
  cap="$(tmux capture-pane -t "$sess" -p 2>/dev/null)"
  printf '%s\n' "$cap" > "$WORK_DIR/tui-smoke.log"
  tmux kill-session -t "$sess" 2>/dev/null || true
  if [ -n "$found" ]; then
    printf 'true\n' > "$WORK_DIR/tui-rendered.txt"
    oqa_pl_pass "V2 TUI rendered under tmux"
  else
    printf 'false\n' > "$WORK_DIR/tui-rendered.txt"
    oqa_pl_log "V2 TUI did not render a known marker in 15s (capture saved)"
  fi
}

TUI_SESSIONS=()
WORK_DIR=""
PROJ_DIR=""
PROJ_B_DIR=""
REPO_BUN_DIR_BEFORE=""

# ---- plugin reload for the translator stats lines ---------------------------
# The host never runs plugin cleanup at process exit (SIGINT/SIGTERM are hard
# exits on 2.4.1), so the "[opencode-v2] event stats " lines reach the logs
# only when a runtime actually stops. A plugin reload stops the previous
# runtime per location: step 1 rewrites the sandbox opencode.json with a
# probe field; step 2 touches the plugin bundle when the rewrite alone is
# not enough. OQA_PL_PLUGIN_BUNDLE and OQA_PL_RELOAD_POLL_SECS exist so the
# self-test can drive this against a fake serve.out and a fake config path.
OQA_PL_PLUGIN_BUNDLE="${OQA_PL_PLUGIN_BUNDLE:-}"
OQA_PL_RELOAD_POLL_SECS="${OQA_PL_RELOAD_POLL_SECS:-20}"

oqa_pl_reload_for_stats() {
  local serve_out="$1" cfg_file="$2" cfg_body="$3" ev_dir="${EV_LIVE:-${TMPDIR:-/tmp}}"
  local poll="$OQA_PL_RELOAD_POLL_SECS" waited=0 found=""
  jq --argjson probe "$RANDOM" '. + {reload_probe: $probe}' <<< "$cfg_body" > "$cfg_file" 2>/dev/null || {
    oqa_pl_fail "plugin reload: config rewrite failed for $cfg_file"
    return 1
  }
  while [ "$waited" -lt "$poll" ]; do
    grep -q '^\[opencode-v2\] event stats ' "$serve_out" 2>/dev/null && { found=1; break; }
    sleep 1
    waited=$((waited + 1))
  done
  if [ -z "$found" ]; then
    touch "${OQA_PL_PLUGIN_BUNDLE:-$REPO_ROOT/dist/index.js}"
    waited=0
    while [ "$waited" -lt "$poll" ]; do
      grep -q '^\[opencode-v2\] event stats ' "$serve_out" 2>/dev/null && { found=1; break; }
      sleep 1
      waited=$((waited + 1))
    done
  fi
  if [ -n "$found" ]; then
    sleep 2
    oqa_pl_log "plugin reload stopped the previous runtimes; stats lines detected in $serve_out"
  else
    oqa_pl_fail "plugin reload produced no [opencode-v2] event stats line within 40s"
  fi
  mkdir -p "$ev_dir"
  { grep '^\[opencode-v2] event stats ' "$serve_out" 2>/dev/null || true; } > "$ev_dir/stats-lines.txt"
  [ -n "$found" ]
}

# ---- registration convergence idle window (the PR #4 pin) -------------------
# The host is idle when this runs: every scenario finished and the MCP
# servers connected. Convergence means "the registration goes quiet and
# STAYS quiet": an event burst early in the window can be ONE correct plugin
# reaction to a late host change (a slow network connects the MCP servers
# after the scenarios end; three locations times four event types is twelve
# to thirteen events, then quiet again), so the pass rule is that the LAST
# HALF of the window carries zero counted *.updated events on the wire AND
# zero reload-relevant plugin writes in the plugin log. First-half events
# and writes are tolerated (a late host change being absorbed once). The SSE
# subscription bounds the window itself (curl -m), so no sleep drives it.
# OQA_PL_IDLE_WINDOW_SECS shrinks the window for the self-test (default 32;
# the live phase budgets it under the +40s driver cap).
#
# Reload-relevant plugin log lines at HEAD are the write-time log statements
# of V2/registration/*.ts (record-only recomputes log the plan-source/
# plan-digest lines and stay excluded; the provider and model appliers of
# provider-model-apply.ts log no apply line at HEAD, a provider/model reload
# surfaces through the *.updated events and the other domain lines):
#   [opencode-v2] tool-registration: registered N plugin tools    (tools.ts)
#   [opencode-v2] command-registration: registered ...           (commands.ts)
#   [opencode-v2] mcp-registration: registered N mcp servers        (mcp.ts)
#   [opencode-v2] agent-registration: replayed N agents          (agents.ts)
#   [opencode-v2] todo-registration: registered N todo tools (todo-tools.ts)
#
# Self-evidencing: the raw SSE capture (every line prefixed with its arrival
# offset in seconds inside the window) lands in $EV_LIVE/idle-window.sse and
# the per-half digest (per event type and location with offsets, plus the
# reload-relevant plugin log lines gained in the last half) in
# $EV_LIVE/idle-window.txt. The verdict messages quote the digest counts.

oqa_pl_idle_now_ms() {
  # GNU date gives millisecond precision; anything else falls back to seconds.
  local t
  t="$(date +%s%3N 2>/dev/null)"
  case "$t" in
    ''|*[!0-9]*) printf '%s000' "$(date +%s)" ;;
    *) printf '%s' "$t" ;;
  esac
}

oqa_pl_idle_iso_ms() {
  # Epoch ms of the plugin logger's ISO-8601 UTC stamp ("[stamp] message");
  # 0 means the stamp did not parse (the caller treats the line as
  # unplaceable and counts it in the last half).
  local iso="$1" t
  t="$(date -u -d "$iso" +%s%3N 2>/dev/null)"
  case "$t" in
    ''|*[!0-9]*) printf '0' ;;
    *) printf '%s' "$t" ;;
  esac
}

oqa_pl_idle_fmt_ms() {
  # "-1" sentinel -> "?" (unplaceable), otherwise "S.mmm".
  local ms="$1"
  if [ "$ms" -lt 0 ]; then printf '?'; return; fi
  printf '%d.%03d' "$((ms / 1000))" "$((ms % 1000))"
}

oqa_pl_idle_window_convergence() {
  local plugin_log="$1" url="$2" pass="$3"
  local window="${OQA_PL_IDLE_WINDOW_SECS:-32}"
  local half=$((window / 2))
  local half_ms=$((half * 1000))
  local ev_dir sse_file digest_file
  ev_dir="${EV_LIVE:-${TMPDIR:-/tmp}}"
  sse_file="$ev_dir/idle-window.sse"
  digest_file="$ev_dir/idle-window.txt"
  mkdir -p "$ev_dir"

  # Byte snapshot BEFORE the window opens: everything the log gains while the
  # window is open is a candidate write.
  local before_bytes
  before_bytes="$(wc -c < "$plugin_log" 2>/dev/null || printf '0')"
  before_bytes="$(printf '%s' "$before_bytes" | tr -d '[:space:]')"

  # Raw SSE capture: every line prefixed with its arrival offset (s) inside
  # the window, so the digest can place each counted event in a half.
  local start_ms line_ms delta line off_s
  start_ms="$(oqa_pl_idle_now_ms)"
  : > "$sse_file"
  while IFS= read -r line; do
    line_ms="$(oqa_pl_idle_now_ms)"
    delta=$((line_ms - start_ms))
    [ "$delta" -lt 0 ] && delta=0
    printf '%d.%03d\t%s\n' "$((delta / 1000))" "$((delta % 1000))" "$line" >> "$sse_file"
  done < <(curl -s -N -m "$window" -u "opencode:$pass" "$url/api/event" 2>/dev/null)

  # Count the *.updated events per half; keep type + location + offset for
  # the digest. The stream is process wide, so the location comes from the
  # event payload ({"type":..,"data":{"location":{"directory":..}},..}).
  local ev_first=0 ev_last=0 ev_lines_first="" ev_lines_last=""
  local off_ms ev_type ev_dir_name ev_line
  while IFS= read -r line; do
    printf '%s' "$line" | grep -q -E '"type":"(provider|model|agent|command)\.updated"' || continue
    off_s="${line%%$'\t'*}"
    ev_line="${line#*$'\t'}"
    off_ms="$(printf '%s' "$off_s" | awk '{ printf "%d", ($1 * 1000) }')"
    ev_type="$(printf '%s' "${ev_line#data: }" | jq -r '.type // "?"' 2>/dev/null || printf '?')"
    ev_dir_name="$(printf '%s' "${ev_line#data: }" | jq -r '.data.location.directory // "?"' 2>/dev/null || printf '?')"
    if [ "$off_ms" -ge "$half_ms" ]; then
      ev_last=$((ev_last + 1))
      ev_lines_last+="  event ${off_s}s ${ev_type} ${ev_dir_name}"$'\n'
    else
      ev_first=$((ev_first + 1))
      ev_lines_first+="  event ${off_s}s ${ev_type} ${ev_dir_name}"$'\n'
    fi
  done < "$sse_file"

  # Classify every plugin log line gained during the window: a reload-
  # relevant write is any registration write marker (see the list above).
  # The offset comes from the line's own logger stamp; an unplaceable line
  # counts in the last half (an unknown place must not pass the pin).
  local write_re after_bytes wr_first=0 wr_last=0 wr_gained=0
  write_re='\[opencode-v2\] (tool-registration: registered|command-registration: registered|mcp-registration: registered|agent-registration: replayed|todo-registration: registered)'
  after_bytes="$(wc -c < "$plugin_log" 2>/dev/null || printf '0')"
  after_bytes="$(printf '%s' "$after_bytes" | tr -d '[:space:]')"
  local wr_lines_last="" iso iso_ms wr_off
  if [ "$after_bytes" -gt "$before_bytes" ] && [ -f "$plugin_log" ]; then
    while IFS= read -r line; do
      wr_gained=$((wr_gained + 1))
      printf '%s' "$line" | grep -qE "$write_re" || continue
      iso="$(printf '%s' "$line" | sed -n 's/^\[\([^]]*\)\].*/\1/p')"
      iso_ms="$(oqa_pl_idle_iso_ms "${iso:-}")"
      if [ "$iso_ms" -le 0 ]; then
        wr_last=$((wr_last + 1))
        wr_lines_last+="  write ?s ${line}"$'\n'
        continue
      fi
      wr_off=$((iso_ms - start_ms))
      [ "$wr_off" -lt 0 ] && wr_off=0
      if [ "$wr_off" -ge "$half_ms" ]; then
        wr_last=$((wr_last + 1))
        wr_lines_last+="  write $(oqa_pl_idle_fmt_ms "$wr_off")s ${line}"$'\n'
      else
        wr_first=$((wr_first + 1))
      fi
    done < <(tail -c "+$((before_bytes + 1))" "$plugin_log" 2>/dev/null)
  fi

  local verdict="FAIL"
  [ "$ev_last" -eq 0 ] && [ "$wr_last" -eq 0 ] && verdict="PASS"
  {
    printf '# idle-window digest (PR #4 registration-convergence pin)\n'
    printf 'window_seconds=%s\n' "$window"
    printf 'quiet_tail_seconds=%s\n' "$half"
    printf 'rule=zero counted *.updated events AND zero reload-relevant plugin writes in the LAST half; first-half activity is one absorbed late host change\n'
    printf 'reload_relevant_markers=tool-registration: registered|command-registration: registered|mcp-registration: registered|agent-registration: replayed|todo-registration: registered\n'
    printf 'events_first_half=%s\n' "$ev_first"
    printf 'events_last_half=%s\n' "$ev_last"
    printf 'plugin_writes_gained_total=%s\n' "$wr_gained"
    printf 'plugin_writes_first_half=%s\n' "$wr_first"
    printf 'plugin_writes_last_half=%s\n' "$wr_last"
    printf 'sse_capture=%s\n' "$sse_file"
    [ -n "$ev_lines_first" ] && printf 'events_first_half_lines:\n%s' "$ev_lines_first"
    [ -n "$ev_lines_last" ] && printf 'events_last_half_lines:\n%s' "$ev_lines_last"
    [ -n "$wr_lines_last" ] && printf 'plugin_writes_last_half_lines:\n%s' "$wr_lines_last"
    printf 'verdict=%s\n' "$verdict"
  } > "$digest_file"

  if [ "$verdict" = "PASS" ]; then
    oqa_pl_pass "registration idle window (${window}s): last ${half}s quiet (events first half: $ev_first, last half: $ev_last; plugin writes first half: $wr_first, last half: $wr_last) (registration converged)"
  else
    oqa_pl_fail "registration idle window (${window}s): last ${half}s not quiet (events first half: $ev_first, last half: $ev_last; plugin writes first half: $wr_first, last half: $wr_last) (registration did not converge)"
  fi
}

# ---- registration steady window (the PR #4 post-activation pin) -------------
# Sits between the last scenario activation (every location's plugin applied
# and the TUI smoke done) and the driver's host config change. A bounded wait
# first proves the MCP servers connected: the host log's `mcp connected` line
# count must exist and hold stable across OQA_PL_STEADY_GRACE_TICKS one-second
# ticks (deadline OQA_PL_STEADY_WAIT_SECS, default 45). Then a quiet window
# (OQA_PL_STEADY_WINDOW_SECS, default 12) streams /api/event; the verdict is
# ZERO counted provider|model|agent|command.updated events on the wire AND
# zero reload-relevant plugin writes gained in the plugin log. The steady
# registration contract: after activation a stable host never reloads.
# Self-evidencing: the raw SSE capture lands in $EV_LIVE/steady-window.sse and
# the digest in $EV_LIVE/steady-window.txt, shaped like the idle-window pin.

oqa_pl_steady_window_quiet() {
  local plugin_log="$1" host_log="$2" url="$3" pass="$4"
  local wait_secs="${OQA_PL_STEADY_WAIT_SECS:-45}"
  local window="${OQA_PL_STEADY_WINDOW_SECS:-12}"
  local grace="${OQA_PL_STEADY_GRACE_TICKS:-5}"
  local ev_dir sse_file digest_file
  ev_dir="${EV_LIVE:-${TMPDIR:-/tmp}}"
  sse_file="$ev_dir/steady-window.sse"
  digest_file="$ev_dir/steady-window.txt"
  mkdir -p "$ev_dir"

  local i count=0 stable=0 connected=0 new_count
  for i in $(seq 1 "$wait_secs"); do
    new_count="$(grep -c 'message="mcp connected"' "$host_log" 2>/dev/null)"
    new_count="${new_count:-0}"
    if [ "$new_count" -gt 0 ] && [ "$new_count" -eq "$count" ]; then
      stable=$((stable + 1))
      [ "$stable" -ge "$grace" ] && { connected=1; break; }
    else
      stable=0
      count="$new_count"
    fi
    if [ -n "${OQA_V2_SERVER_PID:-}" ] && ! kill -0 "$OQA_V2_SERVER_PID" 2>/dev/null; then break; fi
    sleep 1
  done
  [ "$connected" -eq 1 ] || oqa_pl_log "steady window: mcp-connect stability not reached within ${wait_secs}s (lines=$count); judging the window anyway"

  local before_bytes after_bytes
  before_bytes="$(wc -c < "$plugin_log" 2>/dev/null || printf '0')"
  before_bytes="$(printf '%s' "$before_bytes" | tr -d '[:space:]')"

  : > "$sse_file"
  local line
  while IFS= read -r line; do
    printf '%s\n' "$line" >> "$sse_file"
  done < <(curl -s -N -m "$window" -u "opencode:$pass" "$url/api/event" 2>/dev/null)

  local ev_count=0 ev_lines="" ev_type ev_dir_name
  while IFS= read -r line; do
    printf '%s' "$line" | grep -q -E '"type":"(provider|model|agent|command)\.updated"' || continue
    ev_count=$((ev_count + 1))
    ev_type="$(printf '%s' "${line#data: }" | jq -r '.type // "?"' 2>/dev/null || printf '?')"
    ev_dir_name="$(printf '%s' "${line#data: }" | jq -r '.data.location.directory // "?"' 2>/dev/null || printf '?')"
    ev_lines+="  event ${ev_type} ${ev_dir_name}"$'\n'
  done < "$sse_file"

  local write_re wr_gained=0 wr_writes=0 wr_lines=""
  write_re='\[opencode-v2\] (tool-registration: registered|command-registration: registered|mcp-registration: registered|agent-registration: replayed|todo-registration: registered)'
  after_bytes="$(wc -c < "$plugin_log" 2>/dev/null || printf '0')"
  after_bytes="$(printf '%s' "$after_bytes" | tr -d '[:space:]')"
  if [ "$after_bytes" -gt "$before_bytes" ] && [ -f "$plugin_log" ]; then
    while IFS= read -r line; do
      wr_gained=$((wr_gained + 1))
      printf '%s' "$line" | grep -qE "$write_re" || continue
      wr_writes=$((wr_writes + 1))
      wr_lines+="  write ${line}"$'\n'
    done < <(tail -c "+$((before_bytes + 1))" "$plugin_log" 2>/dev/null)
  fi

  local verdict="FAIL"
  [ "$ev_count" -eq 0 ] && [ "$wr_writes" -eq 0 ] && verdict="PASS"
  {
    printf '# steady-window digest (PR #4 post-activation pin)\n'
    printf 'window_seconds=%s\n' "$window"
    printf 'rule=ZERO counted *.updated events AND zero reload-relevant plugin writes after activation and the MCP-connect wait, before the host config change\n'
    printf 'mcp_connected_stable=%s\n' "$connected"
    printf 'mcp_connected_lines=%s\n' "$count"
    printf 'events_in_window=%s\n' "$ev_count"
    printf 'plugin_writes_gained_total=%s\n' "$wr_gained"
    printf 'plugin_reload_writes=%s\n' "$wr_writes"
    printf 'sse_capture=%s\n' "$sse_file"
    [ -n "$ev_lines" ] && printf 'events_in_window_lines:\n%s' "$ev_lines"
    [ -n "$wr_lines" ] && printf 'plugin_reload_write_lines:\n%s' "$wr_lines"
    printf 'verdict=%s\n' "$verdict"
  } > "$digest_file"

  if [ "$verdict" = "PASS" ]; then
    oqa_pl_pass "steady window after activation (${window}s, mcp lines: $count): zero *.updated events, zero reload writes (registration steady)"
  else
    oqa_pl_fail "steady window after activation (${window}s, mcp lines: $count): events=$ev_count reload writes=$wr_writes (registration reloaded after activation)"
  fi
}

# Import mode: the self-test sources this file to exercise the verdict
# table, the strict gate, the L-18 verdict write-back and the bun/ guard
# without any OC2 dependency or trap overwrite. Everything above is
# function/constant definitions only; everything below runs the live flow.
if [ "${OQA_PL_IMPORT_FOR_TEST:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

# ---- main live flow ---------------------------------------------------------

oqa_pl_main() {
  oqa_require node bun curl jq sqlite3 git tmux || return 1
  oqa_pl_verify_oc2 || return 1
  [ -f "$RUNNER" ] || { oqa_pl_fail "live-runner.ts not found: $RUNNER"; return 1; }
  REPO_BUN_DIR_BEFORE="$([ -d "$REPO_ROOT/bun" ] && printf '1' || printf '0')"

  if [ "$NO_BUILD" -eq 0 ]; then
    oqa_pl_log "building the plugin (flocked)..."
    if ! flock /tmp/oqa-w2-build.lock -c "cd '$REPO_ROOT' && bun run build" > "$WORK_BUILD_LOG" 2>&1; then
      oqa_pl_fail "bun run build failed; log: $WORK_BUILD_LOG"
      return 1
    fi
  fi
  [ -f "$REPO_ROOT/dist/index.js" ] || { oqa_pl_fail "dist/index.js missing (run without --no-build)"; return 1; }

  # The lsp MCP resolves the built lsp-tools-mcp dist exactly like V1; build it
  # when missing so the lsp tier registers and L-05 can prove lsp_status.
  if [ ! -f "$REPO_ROOT/packages/lsp-tools-mcp/dist/cli.js" ]; then
    oqa_pl_log "building lsp-tools-mcp (dist missing)..."
    flock /tmp/oqa-w2-build.lock -c "cd '$REPO_ROOT' && bun run build:lsp-tools-mcp" > "$WORK_BUILD_LOG" 2>&1 || {
      oqa_pl_fail "bun run build:lsp-tools-mcp failed; log: $WORK_BUILD_LOG"
      return 1
    }
  fi

  local sys_cmd="" sys_ver_before="" sys_ver_after="" sys_opencode="absent"
  sys_cmd="$(command -v opencode)"
  if [ -n "$sys_cmd" ]; then
    sys_opencode="present"
    sys_ver_before="$("$sys_cmd" --version 2>/dev/null | tail -1)"
  fi
  db_before="$(oqa_v2_real_db_digest)"

  # The baseline recapture runs before oqa_v2_mk_sandbox: the capture owns its
  # own isolated XDG sandbox and needs only the built dist + the system V1 host.
  oqa_pl_recapture_v1_baseline || return 1

  WORK_DIR="$(mktemp -d -t oqa-v2-parity.XXXXXX)"
  oqa_pl_log "work dir: $WORK_DIR"
  FAKE_PORT="$(oqa_v2_find_free_port)"
  oqa_pl_dump_db_sessions "$WORK_DIR/db-before.txt"

  oqa_pl_capture_real_env
  oqa_v2_mk_sandbox || return 1
  # The unified omo user config turns hashline on, disables one non-default
  # plugin tool (look_at) for live row L-16, and pins the atlas model exactly
  # like the V1 baseline capture does (v2-v1-baseline.sh writes the same
  # agents.atlas.model override; without it the atlas prompt resolves a
  # different model and the L-03 byte-equality row fails on the sandbox, not
  # the product). Config keys ride the unified omo config; the
  # "[opencode]" bracketed harness block carries the plugin harness keys.
  local omo_cfg="$OQA_V2_SANDBOX/home/.omo/omo.jsonc"
  mkdir -p "$(dirname "$omo_cfg")"
  # mcp_env_allowlist is user-layer only (security) and lives INSIDE the
  # "[opencode]" harness block: the unified omo schema drops unknown
  # top-level keys, so a top-level allowlist is silently ignored.
  printf '%s\n' '{ "agents": { "atlas": { "model": "anthropic/claude-sonnet-5" } }, "[opencode]": { "hashline_edit": true, "disabled_tools": ["look_at"], "mcp_env_allowlist": ["OQA_SECRET_TOKEN"] } }' > "$omo_cfg"
  oqa_pl_log "sandbox omo config written: $omo_cfg"
  local plugin_dir cfg_dir cfg_body
  plugin_dir="${OQA_V2_PLUGIN_DIR:-$REPO_ROOT}"
  [ -d "$plugin_dir" ] || { oqa_pl_fail "plugin dir not found: $plugin_dir"; return 1; }
  cfg_dir="$(oqa_v2_config_path)" || return 1
  mkdir -p "$cfg_dir"
  # Session model universe: openai/gpt-fake only. A baseline-matching
  # anthropic provider cannot be added here: the title and summary agents
  # resolve to it and the host drives the Anthropic Messages API at the fake
  # server, which 404s and fails every session.
  cfg_body="$(cat <<JSON
{
  "model": "openai/gpt-fake",
  "plugin": ["$plugin_dir"],
  "provider": {
    "openai": {
      "options": { "apiKey": "fake-key", "baseURL": "http://127.0.0.1:$FAKE_PORT/v1" },
      "models": {
        "gpt-fake": { "tool_call": true, "limit": { "context": 200000, "output": 8192 } }
      }
    }
  }
}
JSON
)"
  printf '%s\n' "$cfg_body" > "$cfg_dir/opencode.json"
  oqa_pl_log "sandbox config written (plugin: $plugin_dir)"

  PROJ_DIR="$OQA_V2_SANDBOX/proj"
  PROJ_B_DIR="$OQA_V2_SANDBOX/proj-b"
  local p
  for p in "$PROJ_DIR" "$PROJ_B_DIR"; do
    mkdir -p "$p"
    git -C "$p" init -q
    git -C "$p" -c user.email=oqa@local -c user.name=oqa commit -q --allow-empty -m init
  done
  printf 'parity row nine file\nsecond line\n' > "$PROJ_DIR/parity-file.txt"

  # ---- L-05/L-23 MCP surfaces (plan task 26) ----
  # A per-run invented token value lives ONLY in the sandbox (the token file
  # dies with it); the .mcp.json carries the ${VAR} reference and sits in the
  # serve cwd, which is the project scope the tier-2 loader scans. The probe
  # command is the real lsp-tools-mcp stdio server, so it connects cleanly
  # (no host-log error lines), lists in GET /api/mcp and carries the token in
  # its registry environment. The serve process and the plugin inherit the
  # exported value so the V1 pipeline expands the reference through the
  # allowlist.
  mkdir -p "$OQA_V2_SANDBOX/tmp"
  OQA_PL_SECRET_TOKEN="$(head -c 18 /dev/urandom | base64 | tr -d '\n=+/')"
  printf '%s' "$OQA_PL_SECRET_TOKEN" > "$OQA_V2_SANDBOX/tmp/oqa-secret-token.txt"
  printf '%s\n' "{\"mcpServers\": {\"oqa-secret-probe\": {\"type\": \"stdio\", \"command\": \"node\", \"args\": [\"$REPO_ROOT/packages/lsp-tools-mcp/dist/cli.js\", \"mcp\"], \"env\": {\"OQA_SECRET_TOKEN\": \"\${OQA_SECRET_TOKEN}\"}}}}" \
    > "$OQA_V2_SANDBOX/tmp/.mcp.json"
  oqa_pl_log "sandbox .mcp.json written with the OQA_SECRET_TOKEN probe reference"

  printf '%s\n' '{"steps":[{"text":"OQA_A_FINAL: plain text answer from the fake model"}]}' > "$WORK_DIR/scenario-a.json"
  printf '%s\n' "{\"steps\":[{\"tool_call\":{\"name\":\"read\",\"arguments\":{\"path\":\"$PROJ_DIR/parity-file.txt\"}}},{\"text\":\"OQA_B_FINAL done reading\"}]}" > "$WORK_DIR/scenario-b.json"
  printf '%s\n' "{\"steps\":[{\"tool_call\":{\"name\":\"shell\",\"arguments\":{\"command\":\"cat $PROJ_DIR/parity-file.txt\"}}},{\"text\":\"OQA_C_FINAL done catting\"}]}" > "$WORK_DIR/scenario-c.json"

  mkdir -p "$WORK_DIR/req-a" "$WORK_DIR/req-b" "$WORK_DIR/req-c"
  oqa_pl_start_fake "$WORK_DIR/scenario-a.json" "$WORK_DIR/req-a" || return 1

  local server_start_ms plugin_first_seen_ms="" i st resp
  server_start_ms="$(date +%s%3N)"
  export OQA_SECRET_TOKEN="$OQA_PL_SECRET_TOKEN"
  oqa_v2_serve_start || return 1
  oqa_v2_wait_ready 60 || { oqa_pl_fail "server never became ready"; cat "$OQA_V2_SANDBOX/serve.out" >&2; return 1; }
  # The first-session race pin (PR #4): scenario A launches with NO settle
  # wait, at plugin activation; its prompt POST awaits the host activation
  # boundary itself, so L-04 proves the tool set the FIRST admitted session
  # sees rather than a post-registration state. The active poll below only
  # records the timestamp for L-01/L-20 after that boundary.
  local sid_a="" sid_b="" sid_c="" sid_locb=""
  oqa_pl_run_once a "v2 parity a" "Reply with exactly: OQA_A_FINAL" "$PROJ_DIR" && sid_a="$OQA_PL_SID" || return 1
  for i in $(seq 1 60); do
    resp="$(oqa_v2_api GET /api/plugin 2>/dev/null)" || resp=""
    st="$(printf '%s' "$resp" | jq -r --arg id "${OQA_V2_PLUGIN_ID:-oh-my-openagent}" '.data[] | select(.id == $id) | .state.status' 2>/dev/null)"
    if [ "$st" = "active" ]; then plugin_first_seen_ms="$(date +%s%3N)"; break; fi
    if ! kill -0 "$OQA_V2_SERVER_PID" 2>/dev/null; then break; fi
    sleep 1
  done
  if [ -z "$plugin_first_seen_ms" ]; then
    oqa_pl_log "plugin never reached the active state within 60s (failure QA path: rows L-01/L-02/L-20 will fail)"
  else
    oqa_pl_pass "plugin active $((plugin_first_seen_ms - server_start_ms)) ms after server start"
  fi

  oqa_pl_start_fake "$WORK_DIR/scenario-b.json" "$WORK_DIR/req-b" || return 1
  oqa_pl_run_once b "v2 parity b" "Read parity-file.txt and reply with its exact content" "$PROJ_DIR" && sid_b="$OQA_PL_SID" || return 1
  oqa_pl_start_fake "$WORK_DIR/scenario-c.json" "$WORK_DIR/req-c" || return 1
  oqa_pl_run_once c "v2 parity c" "Run cat $PROJ_DIR/parity-file.txt and tell me what it printed" "$PROJ_DIR" && sid_c="$OQA_PL_SID" || return 1
  oqa_pl_run_once locb "v2 parity locb" "Reply with exactly: OQA_LOC_B_FINAL" "$PROJ_B_DIR" && sid_locb="$OQA_PL_SID" || return 1

  oqa_pl_tui_smoke || true

  # ---- steady window (the PR #4 post-activation pin): every location's
  # plugin applied, the MCP servers connected; the registration must show
  # ZERO reload events and ZERO reload writes before the host config change.
  oqa_pl_steady_window_quiet "$TMPDIR/oh-my-opencode.log" "$(oqa_v2_log_path)/opencode.log" \
    "$OQA_V2_SERVER_URL" "$OQA_V2_SERVER_PASS"

  # ---- L-03 agent captures (plan task 24): GET /api/agent before the host
  # config change, then a config rewrite (a probe agent in the agent section)
  # whose config.updated/agent.updated events trigger the task-23 recompute
  # (500 ms debounce) and the agent replay; the observable settle condition is
  # polled with a deadline, never assumed.
  local hot_agent="oqa-hot-agent"
  local agents_before="$WORK_DIR/agents-before.json" agents_after="$WORK_DIR/agents-after.json"
  oqa_v2_api GET /api/agent > "$agents_before" 2>/dev/null || printf '{"data":[]}' > "$agents_before"
  local cfg_changed
  cfg_changed="$(jq --arg id "$hot_agent" '.agent = ((.agent // {}) + { ($id): { "description": "live parity hot agent", "mode": "subagent" } })' "$cfg_dir/opencode.json")"
  printf '%s\n' "$cfg_changed" > "$cfg_dir/opencode.json"
  oqa_pl_log "host config rewritten with the probe agent $hot_agent (L-03 after-change capture)"
  local i hot_seen="" resp=""
  for i in $(seq 1 60); do
    resp="$(oqa_v2_api GET /api/agent 2>/dev/null)" || resp=""
    if printf '%s' "$resp" | jq -e --arg id "$hot_agent" '[.data[].id] | index($id) != null and index("sisyphus") != null' >/dev/null 2>&1; then
      hot_seen=1
      break
    fi
    if ! kill -0 "$OQA_V2_SERVER_PID" 2>/dev/null; then break; fi
    sleep 1
  done
  if [ -n "$hot_seen" ]; then
    printf '%s' "$resp" > "$agents_after"
    oqa_pl_pass "probe agent $hot_agent visible and sisyphus re-registered after the host config change"
  else
    printf '{"data":[]}' > "$agents_after"
    oqa_pl_log "probe agent never settled within the deadline (failure QA path: L-03 after-change assertions fail)"
  fi

  local host_log_path="$OQA_V2_SANDBOX/host-opencode.log"
  cp "$(oqa_v2_log_path)/opencode.log" "$host_log_path" 2>/dev/null || touch "$host_log_path"
  local plugin_file_log="$OQA_V2_SANDBOX/plugin-file.log"
  cp "$TMPDIR/oh-my-opencode.log" "$plugin_file_log" 2>/dev/null || touch "$plugin_file_log"

  # The L-03 default-agent surface reads scenario A's session context; fetch
  # it while the server is alive and hand the file to the runner by manifest.
  mkdir -p "$EV_LIVE"
  oqa_v2_api GET "/api/session/$sid_a/context" > "$EV_LIVE/context-a.json" 2>/dev/null || true
  local context_a_file="$EV_LIVE/context-a.json"
  oqa_v2_api GET /api/mcp > "$EV_LIVE/mcp-api.json" 2>/dev/null || printf '{"data":[]}' > "$EV_LIVE/mcp-api.json"
  local mcp_api_capture="$EV_LIVE/mcp-api.json"
  oqa_v2_api GET /api/command > "$EV_LIVE/command-api.json" 2>/dev/null || printf '{"data":[]}' > "$EV_LIVE/command-api.json"
  local command_api_capture="$EV_LIVE/command-api.json"

  local serve_location="$OQA_V2_SANDBOX/tmp"
  cat > "$WORK_DIR/manifest.json" <<JSON
{
  "wave": $WAVE,
  "pluginId": "${OQA_V2_PLUGIN_ID:-oh-my-openagent}",
  "serverStartEpochMs": $server_start_ms,
  ${plugin_first_seen_ms:+$(printf '"pluginFirstSeenEpochMs": %s,' "$plugin_first_seen_ms")}
  "scenarios": {
    "a": { "sessionID": "$sid_a", "prompt": "Reply with exactly: OQA_A_FINAL", "requestsFile": "$WORK_DIR/req-a/requests.jsonl", "eventsFile": "$WORK_DIR/a.events.sse", "directory": "$PROJ_DIR" },
    "b": { "sessionID": "$sid_b", "prompt": "Read parity-file.txt and reply with its exact content", "requestsFile": "$WORK_DIR/req-b/requests.jsonl", "eventsFile": "$WORK_DIR/b.events.sse", "directory": "$PROJ_DIR" },
    "c": { "sessionID": "$sid_c", "prompt": "Run cat", "requestsFile": "$WORK_DIR/req-c/requests.jsonl", "eventsFile": "$WORK_DIR/c.events.sse", "directory": "$PROJ_DIR", "file": "$PROJ_DIR/parity-file.txt", "fileContent": "parity row nine file\nsecond line\n" }
  },
  "locations": [
    { "name": "serve", "directory": "$serve_location" },
    { "name": "a", "directory": "$PROJ_DIR", "sessionID": "$sid_a" },
    { "name": "b", "directory": "$PROJ_B_DIR", "sessionID": "$sid_locb" }
  ],
  "tuiSmokeLog": "$WORK_DIR/tui-smoke.log",
  "pluginFileLog": "$plugin_file_log",
  "sandboxOmoConfig": "$omo_cfg",
  "agentsBeforeFile": "$agents_before",
  "agentsAfterFile": "$agents_after",
  "contextAFile": "$context_a_file",
  "mcpApiCaptureFile": "$mcp_api_capture",
  "commandApiCaptureFile": "$command_api_capture",
  "secretTokenFile": "$OQA_V2_SANDBOX/tmp/oqa-secret-token.txt",
  "hotAgentId": "$hot_agent",
  "scriptedSteps": { "a": 1, "b": 2, "c": 2 }
}
JSON

  mkdir -p "$EV_LIVE"
  cp "$OQA_V2_SANDBOX/serve.out" "$EV_LIVE/serve.out" 2>/dev/null || true
  cp "$host_log_path" "$EV_LIVE/host-opencode.log" 2>/dev/null || true
  cp "$plugin_file_log" "$EV_LIVE/plugin-file.log" 2>/dev/null || true
  cp "$WORK_DIR/manifest.json" "$EV_LIVE/manifest.json" 2>/dev/null || true

  oqa_pl_log "running the live runner (live phase)..."
  local live_rc
  ( cd "$REPO_ROOT" && bun "$RUNNER" --wave "$WAVE" --api "$OQA_V2_SERVER_URL" \
      --password "$OQA_V2_SERVER_PASS" --plugin-log "$OQA_V2_SANDBOX/serve.out" \
      --host-log "$host_log_path" --manifest "$WORK_DIR/manifest.json" --out "$EV_LIVE" \
      $STRICT_FLAG ) \
    > "$EV_LIVE/runner-live.out" 2>&1
  live_rc=$?
  cat "$EV_LIVE/runner-live.out" >&2 || true
  if [ "$live_rc" -ne 0 ]; then
    oqa_pl_log "live runner reported failures (rc=$live_rc); continuing to teardown for the evidence"
  fi

  # Persist the raw scenario captures the row checks read, so a failing row
  # can be diffed offline after the work dir and sandbox are gone: the session
  # contexts for the scenarios already driven and the agent before/after
  # captures. Scenarios d/e land in the post phase; their context captures
  # are re-run there once their session ids exist.
  local ctx_key ctx_sid
  for ctx_key in a b c; do
    eval "ctx_sid=\"\$sid_${ctx_key}\""
    [ -n "$ctx_sid" ] && oqa_v2_api GET "/api/session/$ctx_sid/context" \
      > "$EV_LIVE/context-$ctx_key.json" 2>/dev/null || true
  done
  cp "$WORK_DIR/agents-before.json" "$EV_LIVE/agents-before.json" 2>/dev/null || true
  cp "$WORK_DIR/agents-after.json" "$EV_LIVE/agents-after.json" 2>/dev/null || true
  for ctx_key in a b c; do
    cp "$WORK_DIR/req-$ctx_key/requests.jsonl" "$EV_LIVE/requests-$ctx_key.jsonl" 2>/dev/null || true
  done

  # ---- plugin reload for the stats lines, then the host-config-change ----
  # captures (L-10, L-16): after the reload the plugin is active again with a
  # fresh registration; scenario d drives the scripted grep tool call and
  # scenario e captures the visible tool set after the config change.
  oqa_pl_log "triggering the plugin reload so the previous runtimes emit their stats lines..."
  oqa_pl_reload_for_stats "$OQA_V2_SANDBOX/serve.out" "$cfg_dir/opencode.json" "$cfg_body" || true

  local sid_d="" sid_e="" st_post
  for i in $(seq 1 60); do
    st_post="$(oqa_v2_api GET /api/plugin 2>/dev/null | jq -r --arg id "${OQA_V2_PLUGIN_ID:-oh-my-openagent}" '.data[] | select(.id == $id) | .state.status' 2>/dev/null)"
    [ "$st_post" = "active" ] && break
    kill -0 "$OQA_V2_SERVER_PID" 2>/dev/null || break
    sleep 1
  done
  # The reload tail keeps the event loop busy with the MCP reconnects after the
  # plugin reports active; the scenario CLI resolves its server with a 5 s
  # window and a connect inside that churn times out (task-27 live evidence:
  # run d started 7 s after the reload and its CLI timed out while mcp
  # connected spans were still landing). Wait for /api/info to answer within
  # the same 5 s window before the post-phase scenarios; bounded, no sleeps
  # beyond the poll tick.
  for i in $(seq 1 90); do
    info_code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' -u "opencode:$OQA_V2_SERVER_PASS" "$OQA_V2_SERVER_URL/api/info" 2>/dev/null)"
    [ "$info_code" = "200" ] && { oqa_pl_log "post-reload /api/info answered within the 5 s window"; break; }
    kill -0 "$OQA_V2_SERVER_PID" 2>/dev/null || break
    sleep 1
  done
  printf '%s\n' "{\"steps\":[{\"tool_call\":{\"name\":\"grep\",\"arguments\":{\"pattern\":\"parity\",\"path\":\"$PROJ_DIR\",\"output_mode\":\"content\"}}},{\"text\":\"OQA_D_FINAL done grepping\"}]}" > "$WORK_DIR/scenario-d.json"
  printf '%s\n' '{"steps":[{"text":"OQA_E_FINAL plain"}]}' > "$WORK_DIR/scenario-e.json"
  mkdir -p "$WORK_DIR/req-d" "$WORK_DIR/req-e"
  oqa_pl_start_fake "$WORK_DIR/scenario-d.json" "$WORK_DIR/req-d" || true
  oqa_pl_run_once d "v2 parity d" "Search the project for the word parity with grep and reply with the exact result" "$PROJ_DIR" && sid_d="$OQA_PL_SID" || true
  oqa_pl_start_fake "$WORK_DIR/scenario-e.json" "$WORK_DIR/req-e" || true
  oqa_pl_run_once e "v2 parity e" "Reply with exactly: OQA_E_FINAL" "$PROJ_DIR" && sid_e="$OQA_PL_SID" || true

  # Post-phase scenario contexts (d and e) while the server is still alive.
  for ctx_key in d e; do
    eval "ctx_sid=\"\$sid_${ctx_key}\""
    [ -n "$ctx_sid" ] && oqa_v2_api GET "/api/session/$ctx_sid/context" \
      > "$EV_LIVE/context-$ctx_key.json" 2>/dev/null || true
  done

  # The registration convergence pin: the host is idle here (every scenario
  # finished, the MCP servers connected), so any reload event or recompute in
  # this window is the registration failing to converge (PR #4).
  oqa_pl_idle_window_convergence "$TMPDIR/oh-my-opencode.log" "$OQA_V2_SERVER_URL" "$OQA_V2_SERVER_PASS"

  # ---- shutdown, post-shutdown log copies, teardown, post phase ----
  oqa_v2_serve_stop
  unset OQA_SECRET_TOKEN
  sleep 1
  if [ -n "$sys_cmd" ]; then sys_ver_after="$("$sys_cmd" --version 2>/dev/null | tail -1)"; fi
  db_after="$(oqa_v2_real_db_digest)"
  # The stats lines exist only after the server stopped: refresh the evidence
  # copies NOW so the post phase evaluates the cleanup-dependent assertions.
  cp "$OQA_V2_SANDBOX/serve.out" "$EV_LIVE/serve.out" 2>/dev/null || true
  cp "$(oqa_v2_log_path)/opencode.log" "$EV_LIVE/host-opencode.log" 2>/dev/null || true
  cp "$TMPDIR/oh-my-opencode.log" "$EV_LIVE/plugin-file.log" 2>/dev/null || true
  cp "$WORK_DIR/req-d/requests.jsonl" "$EV_LIVE/requests-d.jsonl" 2>/dev/null || true
  cp "$WORK_DIR/req-e/requests.jsonl" "$EV_LIVE/requests-e.jsonl" 2>/dev/null || true

  local sandbox_path="$OQA_V2_SANDBOX"
  oqa_v2_rm_sandbox
  oqa_pl_restore_real_env

  # JSON tokens for the version clause: null when no system opencode exists
  # on this runner (CI), quoted strings exactly as before otherwise.
  local sys_ver_before_json sys_ver_after_json
  if [ -n "$sys_cmd" ]; then
    sys_ver_before_json="\"$sys_ver_before\""
    sys_ver_after_json="\"$sys_ver_after\""
  else
    sys_ver_before_json=null
    sys_ver_after_json=null
  fi

  oqa_pl_dump_db_sessions "$WORK_DIR/db-after.txt"
  oqa_pl_analyze_db_sessions "$sandbox_path"
  local count_before count_after leaks_json ambient_json
  count_before="$(wc -l < "$WORK_DIR/db-before.txt" | tr -d ' ')"
  count_after="$(wc -l < "$WORK_DIR/db-after.txt" | tr -d ' ')"
  leaks_json="$(oqa_pl_json_string_array "$WORK_DIR/leak-dirs.txt")"
  ambient_json="$(oqa_pl_json_string_array "$WORK_DIR/ambient-dirs.txt")"
  {
    printf 'method: sqlite3 id+directory diff of the real opencode.db before/after the run; leak = new session row whose directory is inside the sandbox path\n'
    printf 'sandbox path: %s\n' "$sandbox_path"
    printf 'real db digest: %s -> %s\n' "$db_before" "$db_after"
    printf 'session rows: %s -> %s (delta %s)\n' "$count_before" "$count_after" "$((count_after - count_before))"
    printf 'leaked rows: %s\n' "$(wc -l < "$WORK_DIR/leak-dirs.txt" | tr -d ' ')"
    printf 'ambient directories (%s):\n' "$(wc -l < "$WORK_DIR/ambient-dirs.txt" | tr -d ' ')"
    cat "$WORK_DIR/ambient-dirs.txt"
  } > "$EV_LIVE/isolation-sessions.txt"

  cat > "$WORK_DIR/post-manifest.json" <<JSON
{
  "wave": $WAVE,
  "pluginId": "${OQA_V2_PLUGIN_ID:-oh-my-openagent}",
  "serverStartEpochMs": $server_start_ms,
  ${plugin_first_seen_ms:+$(printf '"pluginFirstSeenEpochMs": %s,' "$plugin_first_seen_ms")}
  "scenarios": {
    "a": { "sessionID": "$sid_a", "prompt": "Reply with exactly: OQA_A_FINAL", "requestsFile": "$WORK_DIR/req-a/requests.jsonl", "eventsFile": "$WORK_DIR/a.events.sse", "directory": "$PROJ_DIR" },
    "b": { "sessionID": "$sid_b", "prompt": "Read parity-file.txt and reply with its exact content", "requestsFile": "$WORK_DIR/req-b/requests.jsonl", "eventsFile": "$WORK_DIR/b.events.sse", "directory": "$PROJ_DIR" },
    "c": { "sessionID": "$sid_c", "prompt": "Run cat", "requestsFile": "$WORK_DIR/req-c/requests.jsonl", "eventsFile": "$WORK_DIR/c.events.sse", "directory": "$PROJ_DIR", "file": "$PROJ_DIR/parity-file.txt", "fileContent": "parity row nine file\nsecond line\n" },
    "d": { "sessionID": "$sid_d", "prompt": "Search the project for the word parity with grep", "requestsFile": "$WORK_DIR/req-d/requests.jsonl", "eventsFile": "$WORK_DIR/d.events.sse", "directory": "$PROJ_DIR", "file": "$PROJ_DIR/parity-file.txt", "fileContent": "parity row nine file\nsecond line\n" },
    "e": { "sessionID": "$sid_e", "prompt": "Reply with exactly: OQA_E_FINAL", "requestsFile": "$WORK_DIR/req-e/requests.jsonl", "eventsFile": "$WORK_DIR/e.events.sse", "directory": "$PROJ_DIR" }
  },
  "locations": [],
  "pluginFileLog": "$EV_LIVE/plugin-file.log",
  "sandboxOmoConfig": "$omo_cfg",
  "agentsBeforeFile": "$agents_before",
  "agentsAfterFile": "$agents_after",
  "hotAgentId": "$hot_agent",
  "sandboxPath": "$sandbox_path",
  "isolation": {
    "systemOpencode": "$sys_opencode",
    "systemVersionBefore": $sys_ver_before_json,
    "systemVersionAfter": $sys_ver_after_json,
    "dbDigestBefore": "$db_before",
    "dbDigestAfter": "$db_after",
    "sessionCountBefore": $count_before,
    "sessionCountAfter": $count_after,
    "method": "sqlite3 id+directory diff of the real opencode.db before/after the run; leak = new session row whose directory is inside the sandbox path",
    "leakedSessionDirectories": $leaks_json,
    "ambientSessionDirectories": $ambient_json
  }
}
JSON

  oqa_pl_log "running the live runner (post phase)..."
  local post_rc
  ( cd "$REPO_ROOT" && bun "$RUNNER" --wave "$WAVE" --api "$OQA_V2_SERVER_URL" \
      --password "$OQA_V2_SERVER_PASS" --plugin-log "$EV_LIVE/serve.out" \
      --host-log "$EV_LIVE/host-opencode.log" --manifest "$WORK_DIR/post-manifest.json" \
      --out "$EV_LIVE" --post $STRICT_FLAG ) > "$EV_LIVE/runner-post.out" 2>&1
  post_rc=$?
  cat "$EV_LIVE/runner-post.out" >&2 || true

  local v1_rc=0
  if [ "$SKIP_V1" -eq 0 ]; then
    oqa_pl_log "running v2-v1-regression.sh (L-18)..."
    env -i HOME="$OQA_PL_REAL_HOME" PATH="$OQA_PL_REAL_PATH" TMPDIR="${OQA_PL_REAL_TMPDIR:-/tmp}" \
      TERM="${TERM:-xterm}" bash "$SCRIPT_DIR/v2-v1-regression.sh" > "$EV_LIVE/v1-regression.out" 2>&1
    v1_rc=$?
    cat "$EV_LIVE/v1-regression.out" >&2 || true
    oqa_pl_apply_v1_verdict "$EV_LIVE/v1-regression.out" || true
  else
    oqa_pl_log "--skip-v1: L-18 stays pending with its owner named (owner: v2-v1-regression.sh)"
  fi

  oqa_pl_print_table || true
  oqa_pl_bun_junk_check || true

  local rc=1
  if [ "$live_rc" -eq 0 ] && [ "$post_rc" -eq 0 ] && [ "$v1_rc" -eq 0 ] && [ "$FAILS" -eq 0 ] && oqa_pl_strict_gate; then rc=0; fi
  return "$rc"
}

EV_LIVE="${OQA_V2_OUT:-$REPO_ROOT/.omo/evidence/$(date +%Y%m%d)-opencode-v2-compat/task-20/live}"
WORK_BUILD_LOG="$(mktemp -t oqa-v2-parity-build.XXXXXX.log)"
[ "$CI" -eq 1 ] && oqa_pl_log "ci mode: non-interactive, evidence under $EV_LIVE"

while [ $# -gt 0 ]; do
  case "$1" in
    --wave) [ $# -ge 2 ] || { printf 'error: --wave requires a number\n' >&2; exit 2; }; WAVE="$2"; shift 2 ;;
    --ci) CI=1; shift ;;
    --strict) STRICT=1; STRICT_FLAG="--strict"; shift ;;
    --skip-v1) SKIP_V1=1; shift ;;
    --self-test) SELF_TEST=1; shift ;;
    --no-build) NO_BUILD=1; shift ;;
    --recapture-v1-baseline) RECAPTURE_V1_BASELINE=1; shift ;;
    -h|--help) sed -n '2,36p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[ -n "$WAVE" ] || [ "$SELF_TEST" -eq 1 ] || { printf 'error: --wave is required\n' >&2; exit 2; }

# The self-test runs the runner against the stub API only, so it dispatches
# BEFORE the sandbox library boots the pinned OC2 binary.
if [ "$SELF_TEST" -eq 1 ]; then
  bash "$SCRIPT_DIR/lib/v2-live-self-test.sh"
  exit $?
fi

. "$SCRIPT_DIR/lib/v2-sandbox.sh"

oqa_pl_on_exit() {
  for s in "${TUI_SESSIONS[@]:-}"; do [ -n "$s" ] && tmux kill-session -t "$s" 2>/dev/null || true; done
  oqa_pl_stop_evt
  [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null || true
  oqa_v2_teardown
  [ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR"
}
# bash does not run EXIT traps on untrapped fatal signals; route them through
# exit so the teardown chain (sandbox + WORK_DIR removal) always runs. The
# registration sits AFTER the --self-test dispatch and the sandbox sourcing
# (oqa_v2_teardown must exist), so the self-test run never arms this trap.
trap oqa_pl_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

oqa_pl_main
exit $?
