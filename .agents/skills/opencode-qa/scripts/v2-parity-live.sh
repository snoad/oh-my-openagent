#!/usr/bin/env bash
# v2-parity-live.sh - drive the live OpenCode 2 parity rows (plan task 20).
#
# Flow: verify $OC2 and its version (fail fast with the bootstrap command),
# run `bun run build` unless --no-build, create the isolated sandbox with the
# plugin equal to the repo root, start the scenario fake model and the
# sandboxed server, drive scenarios A (plain text), B (read tool), C (shell
# cat) plus a second-location session and a minimal TUI smoke, run the live
# runner (V2/parity/live-runner.ts) against the live surfaces, tear the
# sandbox down, run the post phase (L-15), then run v2-v1-regression.sh
# (L-18) unless --skip-v1. Prints the result table and exits 0 only when
# every selected row passed.
#
# Usage:
#   v2-parity-live.sh --wave <n> [--ci] [--skip-v1] [--self-test] [--no-build]
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
SKIP_V1=0
SELF_TEST=0
NO_BUILD=0
EV_LIVE=""

oqa_pl_log()  { printf '[v2-parity-live] %s\n' "$*" >&2; }
oqa_pl_pass() { printf 'PASS: %s\n' "$*"; }
oqa_pl_fail() { printf 'FAIL: %s\n' "$*" >&2; FAILS=$((FAILS + 1)); return 1; }
FAILS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --wave) [ $# -ge 2 ] || { printf 'error: --wave requires a number\n' >&2; exit 2; }; WAVE="$2"; shift 2 ;;
    --ci) CI=1; shift ;;
    --skip-v1) SKIP_V1=1; shift ;;
    --self-test) SELF_TEST=1; shift ;;
    --no-build) NO_BUILD=1; shift ;;
    -h|--help) sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
trap 'for s in "${TUI_SESSIONS[@]:-}"; do [ -n "$s" ] && tmux kill-session -t "$s" 2>/dev/null || true; done; oqa_pl_stop_evt; [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null || true; oqa_v2_teardown' EXIT

# ---- main live flow ---------------------------------------------------------

WORK_DIR=""
PROJ_DIR=""
PROJ_B_DIR=""

oqa_pl_main() {
  oqa_require node bun curl jq sqlite3 git tmux || return 1
  oqa_pl_verify_oc2 || return 1
  [ -f "$RUNNER" ] || { oqa_pl_fail "live-runner.ts not found: $RUNNER"; return 1; }

  if [ "$NO_BUILD" -eq 0 ]; then
    oqa_pl_log "building the plugin (flocked)..."
    if ! flock /tmp/oqa-w2-build.lock -c "cd '$REPO_ROOT' && bun run build" > "$WORK_BUILD_LOG" 2>&1; then
      oqa_pl_fail "bun run build failed; log: $WORK_BUILD_LOG"
      return 1
    fi
  fi
  [ -f "$REPO_ROOT/dist/index.js" ] || { oqa_pl_fail "dist/index.js missing (run without --no-build)"; return 1; }

  local sys_cmd sys_ver_before sys_ver_after db_before db_after
  sys_cmd="$(command -v opencode)"
  sys_ver_before="$("$sys_cmd" --version 2>/dev/null | tail -1)"
  db_before="$(oqa_v2_real_db_digest)"

  WORK_DIR="$(mktemp -d -t oqa-v2-parity.XXXXXX)"
  oqa_pl_log "work dir: $WORK_DIR"
  FAKE_PORT="$(oqa_v2_find_free_port)"

  OQA_PL_REAL_HOME="$HOME"
  OQA_PL_REAL_PATH="$PATH"
  OQA_PL_REAL_XDG_CONFIG="${XDG_CONFIG_HOME:-}"
  OQA_PL_REAL_XDG_DATA="${XDG_DATA_HOME:-}"
  OQA_PL_REAL_XDG_CACHE="${XDG_CACHE_HOME:-}"
  OQA_PL_REAL_XDG_STATE="${XDG_STATE_HOME:-}"
  OQA_PL_REAL_TMPDIR="${TMPDIR:-/tmp}"
  oqa_v2_mk_sandbox || return 1
  local plugin_dir cfg_dir
  plugin_dir="${OQA_V2_PLUGIN_DIR:-$REPO_ROOT}"
  [ -d "$plugin_dir" ] || { oqa_pl_fail "plugin dir not found: $plugin_dir"; return 1; }
  cfg_dir="$(oqa_v2_config_path)" || return 1
  mkdir -p "$cfg_dir"
  cat > "$cfg_dir/opencode.json" <<JSON
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

  printf '%s\n' '{"steps":[{"text":"OQA_A_FINAL: plain text answer from the fake model"}]}' > "$WORK_DIR/scenario-a.json"
  printf '%s\n' "{\"steps\":[{\"tool_call\":{\"name\":\"read\",\"arguments\":{\"path\":\"$PROJ_DIR/parity-file.txt\"}}},{\"text\":\"OQA_B_FINAL done reading\"}]}" > "$WORK_DIR/scenario-b.json"
  printf '%s\n' "{\"steps\":[{\"tool_call\":{\"name\":\"shell\",\"arguments\":{\"command\":\"cat $PROJ_DIR/parity-file.txt\"}}},{\"text\":\"OQA_C_FINAL done catting\"}]}" > "$WORK_DIR/scenario-c.json"

  mkdir -p "$WORK_DIR/req-a" "$WORK_DIR/req-b" "$WORK_DIR/req-c"
  oqa_pl_start_fake "$WORK_DIR/scenario-a.json" "$WORK_DIR/req-a" || return 1

  local server_start_ms plugin_first_seen_ms="" i st resp
  server_start_ms="$(date +%s%3N)"
  oqa_v2_serve_start || return 1
  oqa_v2_wait_ready 60 || { oqa_pl_fail "server never became ready"; cat "$OQA_V2_SANDBOX/serve.out" >&2; return 1; }
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

  local sid_a="" sid_b="" sid_c="" sid_locb=""
  oqa_pl_run_once a "v2 parity a" "Reply with exactly: OQA_A_FINAL" "$PROJ_DIR" && sid_a="$OQA_PL_SID" || return 1
  oqa_pl_start_fake "$WORK_DIR/scenario-b.json" "$WORK_DIR/req-b" || return 1
  oqa_pl_run_once b "v2 parity b" "Read parity-file.txt and reply with its exact content" "$PROJ_DIR" && sid_b="$OQA_PL_SID" || return 1
  oqa_pl_start_fake "$WORK_DIR/scenario-c.json" "$WORK_DIR/req-c" || return 1
  oqa_pl_run_once c "v2 parity c" "Run cat $PROJ_DIR/parity-file.txt and tell me what it printed" "$PROJ_DIR" && sid_c="$OQA_PL_SID" || return 1
  oqa_pl_run_once locb "v2 parity locb" "Reply with exactly: OQA_LOC_B_FINAL" "$PROJ_B_DIR" && sid_locb="$OQA_PL_SID" || return 1

  oqa_pl_tui_smoke || true

  local host_log_path="$OQA_V2_SANDBOX/host-opencode.log"
  cp "$(oqa_v2_log_path)/opencode.log" "$host_log_path" 2>/dev/null || touch "$host_log_path"
  local plugin_file_log="$OQA_V2_SANDBOX/plugin-file.log"
  cp "$TMPDIR/oh-my-opencode.log" "$plugin_file_log" 2>/dev/null || touch "$plugin_file_log"

  local serve_location="$OQA_V2_SANDBOX/tmp"
  cat > "$WORK_DIR/manifest.json" <<JSON
{
  "wave": $WAVE,
  "pluginId": "${OQA_V2_PLUGIN_ID:-oh-my-openagent}",
  "serverStartEpochMs": $server_start_ms,
  ${plugin_first_seen_ms:+$(printf '"pluginFirstSeenEpochMs": %s,' "$plugin_first_seen_ms")}
  "scenarios": {
    "a": { "sessionID": "$sid_a", "prompt": "Reply with exactly: OQA_A_FINAL", "requestsFile": "$WORK_DIR/req-a/requests.jsonl", "eventsFile": "$WORK_DIR/a.events.sse" },
    "b": { "sessionID": "$sid_b", "prompt": "Read parity-file.txt and reply with its exact content", "requestsFile": "$WORK_DIR/req-b/requests.jsonl", "eventsFile": "$WORK_DIR/b.events.sse" },
    "c": { "sessionID": "$sid_c", "prompt": "Run cat", "requestsFile": "$WORK_DIR/req-c/requests.jsonl", "eventsFile": "$WORK_DIR/c.events.sse" }
  },
  "locations": [
    { "name": "serve", "directory": "$serve_location" },
    { "name": "a", "directory": "$PROJ_DIR", "sessionID": "$sid_a" },
    { "name": "b", "directory": "$PROJ_B_DIR", "sessionID": "$sid_locb" }
  ],
  "tuiSmokeLog": "$WORK_DIR/tui-smoke.log",
  "pluginFileLog": "$plugin_file_log",
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
      --host-log "$host_log_path" --manifest "$WORK_DIR/manifest.json" --out "$EV_LIVE" ) \
    > "$EV_LIVE/runner-live.out" 2>&1
  live_rc=$?
  cat "$EV_LIVE/runner-live.out" >&2 || true
  if [ "$live_rc" -ne 0 ]; then
    oqa_pl_log "live runner reported failures (rc=$live_rc); continuing to teardown for the evidence"
  fi

  # ---- teardown + post phase ----
  oqa_v2_serve_stop
  sleep 1
  sys_ver_after="$("$sys_cmd" --version 2>/dev/null | tail -1)"
  db_after="$(oqa_v2_real_db_digest)"
  cp "$OQA_V2_SANDBOX/serve.out" "$EV_LIVE/serve.out" 2>/dev/null || true
  cat > "$WORK_DIR/post-manifest.json" <<JSON
{
  "wave": $WAVE,
  "pluginId": "${OQA_V2_PLUGIN_ID:-oh-my-openagent}",
  "serverStartEpochMs": $server_start_ms,
  ${plugin_first_seen_ms:+$(printf '"pluginFirstSeenEpochMs": %s,' "$plugin_first_seen_ms")}
  "scenarios": {},
  "locations": [],
  "pluginFileLog": "$plugin_file_log",
  "sandboxPath": "$OQA_V2_SANDBOX",
  "isolation": {
    "systemVersionBefore": "$sys_ver_before",
    "systemVersionAfter": "$sys_ver_after",
    "dbDigestBefore": "$db_before",
    "dbDigestAfter": "$db_after",
    "sessionCountBefore": $(session_count_of "$db_before"),
    "sessionCountAfter": $(session_count_of "$db_after")
  }
}
JSON
  oqa_v2_rm_sandbox
  # The sandbox exports are still live after the removal; any later process
  # (the post-phase bun runner) would recreate cache/data dirs inside the
  # removed path and flip L-15, so restore the real environment first.
  export HOME="$OQA_PL_REAL_HOME" XDG_CONFIG_HOME="$OQA_PL_REAL_XDG_CONFIG"
  export XDG_DATA_HOME="$OQA_PL_REAL_XDG_DATA" XDG_CACHE_HOME="$OQA_PL_REAL_XDG_CACHE"
  export XDG_STATE_HOME="$OQA_PL_REAL_XDG_STATE" TMPDIR="$OQA_PL_REAL_TMPDIR"

  oqa_pl_log "running the live runner (post phase)..."
  local post_rc
  ( cd "$REPO_ROOT" && bun "$RUNNER" --wave "$WAVE" --api "$OQA_V2_SERVER_URL" \
      --password "$OQA_V2_SERVER_PASS" --plugin-log "$EV_LIVE/serve.out" \
      --host-log "$EV_LIVE/host-opencode.log" --manifest "$WORK_DIR/post-manifest.json" \
      --out "$EV_LIVE" --post ) > "$EV_LIVE/runner-post.out" 2>&1
  post_rc=$?
  cat "$EV_LIVE/runner-post.out" >&2 || true

  local v1_rc=0
  if [ "$SKIP_V1" -eq 0 ]; then
    oqa_pl_log "running v2-v1-regression.sh (L-18)..."
    env -i HOME="$OQA_PL_REAL_HOME" PATH="$OQA_PL_REAL_PATH" TMPDIR="${OQA_PL_REAL_TMPDIR:-/tmp}" \
      TERM="${TERM:-xterm}" bash "$SCRIPT_DIR/v2-v1-regression.sh" > "$EV_LIVE/v1-regression.out" 2>&1
    v1_rc=$?
    cat "$EV_LIVE/v1-regression.out" >&2 || true
  fi

  oqa_pl_print_table || true

  local rc=1
  if [ "$live_rc" -eq 0 ] && [ "$post_rc" -eq 0 ] && [ "$v1_rc" -eq 0 ] && [ "$FAILS" -eq 0 ]; then rc=0; fi
  return "$rc"
}

session_count_of() {
  local count
  count="$(printf '%s' "$1" | sed -n 's/.*sessions=\([0-9?]*\)$/\1/p')"
  printf '%s' "${count:--1}"
}

oqa_pl_print_table() {
  local results="$EV_LIVE/results.json"
  [ -f "$results" ] || { oqa_pl_log "no results.json at $results"; return 1; }
  printf '%s\n' "---- live parity result table (wave $WAVE) ----"
  jq -r 'sort_by(.row)[] | "\(if .pass == true then "PASS" elif .pass == false then "FAIL" elif .pass == "stop" then "STOP" else "PENDING" end)  \(.row)  \(.summary)"' "$results"
  printf '%s\n' "--------------------------------------------------"
  local fails
  fails="$(jq '[.[] | select(.pass == false)] | length' "$results")"
  if [ "${fails:-0}" -gt 0 ]; then
    oqa_pl_fail "$fails live row(s) FAILED"
    return 1
  fi
  oqa_pl_pass "every executed live row passed"
}

EV_LIVE="${OQA_V2_OUT:-$REPO_ROOT/.omo/evidence/$(date +%Y%m%d)-opencode-v2-compat/task-20/live}"
WORK_BUILD_LOG="$(mktemp -t oqa-v2-parity-build.XXXXXX.log)"
[ "$CI" -eq 1 ] && oqa_pl_log "ci mode: non-interactive, evidence under $EV_LIVE"
oqa_pl_main
exit $?
