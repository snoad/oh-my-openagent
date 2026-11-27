#!/usr/bin/env bash
# v2-v1-regression.sh - live row L-18 (plan task 20): the V1 regression on
# the system OpenCode 1.x.
#
# Boots the V1 sandbox exactly the way v2-v1-baseline.sh captured it (the
# isolated XDG env, the plugin through its V1 "file://<repo-root>" entry, the
# atlas model pin in the sandbox ~/.omo/omo.jsonc), compares the agent and
# tool lists against packages/omo-opencode/src/opencode-v2/parity/fixtures/
# v1-baseline/ (ignoring the envDependent tools), asserts the V1 sandbox log
# carries no "[opencode-v2] engine started" marker, then runs the existing
# tui-smoke.sh. The system OpenCode (never the OC2 sandbox binary, never
# reconfigured) must be a 1.x release.
#
# Usage:
#   v2-v1-regression.sh [--no-tui]   # --no-tui skips tui-smoke.sh
#
# Env:
#   OQA_V1_EVIDENCE   evidence copy dir (default none)
#
# System dependencies: bash, the system V1 `opencode` binary (1.x), curl, jq,
# sqlite3 and tmux (tui-smoke.sh). The CI job of plan task 21 installs only
# tmux and jq on ubuntu-latest; curl/git/sqlite3 are preinstalled there and
# the job runs with --skip-v1, so the V1 host is a local-QA dependency only.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/common.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
FIXTURES_DIR="$REPO_ROOT/packages/omo-opencode/src/opencode-v2/parity/fixtures/v1-baseline"
BASELINE_MODEL_PROVIDER="anthropic"
BASELINE_MODEL="claude-opus-5-5"

RUN_TUI=1
[ "${1:-}" = "--no-tui" ] && RUN_TUI=0

oqa_v1r_log()  { printf '[v2-v1-regression] %s\n' "$*" >&2; }
oqa_v1r_pass() { printf 'PASS: %s\n' "$*"; }
oqa_v1r_fail() { printf 'FAIL: %s\n' "$*" >&2; FAILS=$((FAILS + 1)); return 1; }
FAILS=0

oqa_v1r_require_v1_host() {
  local ver
  ver="$(opencode --version 2>/dev/null | tail -1)"
  case "$ver" in
    1.*) oqa_v1r_log "system opencode is V1 ($ver)"; return 0 ;;
    *)   oqa_v1r_fail "system opencode version '$ver' does not start with 1."; return 1 ;;
  esac
}

oqa_v1r_wait_health() {
  local timeout="${1:-90}" code="" deadline
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -u "opencode:$OQA_SERVER_PASS" \
      "$OQA_SERVER_URL/global/health" 2>/dev/null)"
    [ "$code" = "200" ] && return 0
    if ! kill -0 "$OQA_SERVER_PID" 2>/dev/null; then
      [ "$code" = "200" ] && return 0
      return 1
    fi
    sleep 1
  done
  return 1
}

oqa_v1r_dump_db_sessions() {
  # "<id>|<directory>" rows of the real DB (read-only). Missing DB -> empty.
  local db="$1" out="$2"
  if [ -f "$db" ]; then
    sqlite3 "$db" "SELECT id || '|' || COALESCE(directory,'') FROM session" 2>/dev/null > "$out" || : > "$out"
  else
    : > "$out"
  fi
}

oqa_v1r_main() {
  oqa_require opencode curl jq sqlite3 || return 1
  oqa_v1r_require_v1_host || return 1
  [ -f "$FIXTURES_DIR/agents.json" ] || { oqa_v1r_fail "v1-baseline fixture missing (run v2-v1-baseline.sh first)"; return 1; }
  [ -f "$REPO_ROOT/dist/index.js" ] || { oqa_v1r_fail "dist/index.js not found (run bun run build first)"; return 1; }

  local real_db dump_before dump_after
  real_db="$(oqa_db_path)"
  dump_before="$(mktemp -t oqa-v1r-db.XXXXXX)"
  dump_after="$(mktemp -t oqa-v1r-db.XXXXXX)"
  oqa_v1r_dump_db_sessions "$real_db" "$dump_before"

  oqa_mk_isolated_xdg || return 1
  mkdir -p "$HOME/.omo"
  printf '{"agents":{"atlas":{"model":"anthropic/claude-sonnet-5"}}}\n' > "$HOME/.omo/omo.jsonc"
  mkdir -p "$XDG_CONFIG_HOME/opencode"
  printf '{\n  "plugin": ["file://%s"]\n}\n' "$REPO_ROOT" > "$XDG_CONFIG_HOME/opencode/opencode.jsonc"

  local neutral="$OQA_XDG_ROOT/neutral"
  local xdg_root="$OQA_XDG_ROOT"
  mkdir -p "$neutral"

  local port pass
  port="$(oqa_free_port)"
  pass="oqa-v1-regression"
  (cd "$neutral" && OPENCODE_SERVER_PASSWORD="$pass" exec opencode serve \
      --port "$port" --hostname 127.0.0.1 \
      > "$XDG_STATE_HOME/serve.log" 2>&1 < /dev/null) &
  OQA_SERVER_PID=$!
  disown "$OQA_SERVER_PID" 2>/dev/null || true
  export OQA_SERVER_PORT="$port" OQA_SERVER_PASS="$pass" OQA_SERVER_URL="http://127.0.0.1:$port"

  if ! oqa_v1r_wait_health 90; then
    oqa_v1r_fail "V1 server did not become ready; log follows:"
    cat "$XDG_STATE_HOME/serve.log" >&2 2>/dev/null || true
    oqa_cleanup
    rm -f "$dump_before" "$dump_after"
    return 1
  fi

  local work
  work="$(mktemp -d -t oqa-v1-regr.XXXXXX)"
  # GET /agent measured 89.7 s (HTTP 200, 450 KB) on a slow-link day while
  # the sandbox held connections to Cloudflare: the plugin config phase dials
  # remote endpoints, so the curls run with generous timeouts and print the
  # measured durations into the L-18 evidence.
  local agent_raw tool_raw agent_curl_rc tool_curl_rc agent_time tool_time
  curl -sS -m 300 -u "opencode:$pass" "$OQA_SERVER_URL/agent" \
    -o "$work/agent-raw.json" -w '%{time_total}' > "$work/agent-time" 2>"$work/agent-curl.err"
  agent_curl_rc=$?
  agent_raw="$(cat "$work/agent-raw.json" 2>/dev/null || true)"
  agent_time="$(cat "$work/agent-time" 2>/dev/null || true)"
  curl -sS -m 120 -u "opencode:$pass" \
    "$OQA_SERVER_URL/experimental/tool?directory=$neutral&provider=$BASELINE_MODEL_PROVIDER&model=$BASELINE_MODEL" \
    -o "$work/tool-raw.json" -w '%{time_total}' > "$work/tool-time" 2>"$work/tool-curl.err"
  tool_curl_rc=$?
  tool_raw="$(cat "$work/tool-raw.json" 2>/dev/null || true)"
  tool_time="$(cat "$work/tool-time" 2>/dev/null || true)"
  [ -n "$agent_time" ] || agent_time="n/a"
  [ -n "$tool_time" ] || tool_time="n/a"
  [ "$agent_curl_rc" -eq 0 ] || oqa_v1r_log "GET /agent curl rc=$agent_curl_rc after ${agent_time}s: $(head -c 300 "$work/agent-curl.err" 2>/dev/null)"
  [ "$tool_curl_rc" -eq 0 ] || oqa_v1r_log "GET /experimental/tool curl rc=$tool_curl_rc after ${tool_time}s: $(head -c 300 "$work/tool-curl.err" 2>/dev/null)"
  oqa_v1r_log "GET /agent took ${agent_time}s; GET /experimental/tool took ${tool_time}s"

  cp "$XDG_STATE_HOME/serve.log" "$work/serve.log" 2>/dev/null || true
  printf '%s' "$agent_raw" | jq -S '[.[] | {id: (.name | split(" - ")[0] | ascii_downcase),
      name, mode, hidden, native}]' > "$work/agents-live.json" 2>/dev/null || true

  oqa_cleanup
  unset OQA_SERVER_PID OQA_SERVER_URL OQA_SERVER_PASS OQA_SERVER_PORT

  # Leak-based isolation: unrelated processes may create real-DB sessions
  # during the window (recorded as ambient, never gating); a real leak is
  # any NEW session row whose directory lies inside the V1 sandbox root.
  oqa_v1r_dump_db_sessions "$real_db" "$dump_after"
  local count_before count_after leak_count
  count_before="$(wc -l < "$dump_before" | tr -d ' ')"
  count_after="$(wc -l < "$dump_after" | tr -d ' ')"
  awk -F'|' 'NR==FNR { seen[$1] = 1; next } !($1 in seen)' "$dump_before" "$dump_after" > "$dump_after.new"
  leak_count="$(awk -F'|' -v root="$xdg_root" 'index($2, root "/") == 1 || $2 == root' "$dump_after.new" | wc -l | tr -d ' ')"
  awk -F'|' -v root="$xdg_root" 'index($2, root "/") == 1 || $2 == root' "$dump_after.new" > "$work/leak-rows.txt" 2>/dev/null || : > "$work/leak-rows.txt"
  awk -F'|' -v root="$xdg_root" 'index($2, root "/") != 1 && $2 != root { print $2 }' "$dump_after.new" > "$work/ambient-dirs.txt" 2>/dev/null || : > "$work/ambient-dirs.txt"
  {
    printf 'method: sqlite3 id+directory diff of %s before/after the run\n' "$real_db"
    printf 'sandbox root: %s\n' "$xdg_root"
    printf 'session count: %s -> %s\n' "$count_before" "$count_after"
    printf 'leaked rows: %s\n' "$leak_count"
    printf 'ambient directories:\n'
    cat "$work/ambient-dirs.txt"
  } > "$work/isolation.txt"
  if [ -n "${OQA_V1_EVIDENCE:-}" ]; then
    mkdir -p "$OQA_V1_EVIDENCE"
    cp "$work/isolation.txt" "$OQA_V1_EVIDENCE/isolation.txt" 2>/dev/null || true
  fi
  if [ "$leak_count" -gt 0 ]; then
    oqa_v1r_fail "isolation: $leak_count real-DB session row(s) created inside the V1 sandbox ($xdg_root)"
    head -5 "$work/leak-rows.txt" >&2 || true
  else
    oqa_v1r_pass "isolation: no real-DB session leaked into the V1 sandbox ($count_before -> $count_after, $(wc -l < "$work/ambient-dirs.txt" | tr -d ' ') ambient row(s) recorded)"
  fi

  agent_ok=0
  if printf '%s' "$agent_raw" | jq -e 'type == "array"' >/dev/null 2>&1; then
    if [ "$(sha256sum "$work/agents-live.json" | cut -d' ' -f1)" = "$(sha256sum "$FIXTURES_DIR/agents.json" | cut -d' ' -f1)" ]; then
      oqa_v1r_pass "agent list equals the V1 baseline (byte-identical normalized capture)"
      agent_ok=1
    else
      oqa_v1r_fail "agent list drifted from the V1 baseline:"
      diff <(jq -S . "$FIXTURES_DIR/agents.json") <(jq -S . "$work/agents-live.json") | head -20 >&2 || true
    fi
  else
    oqa_v1r_fail "GET /agent did not return a JSON array"
  fi

  tools_ok=0
  if printf '%s' "$tool_raw" | jq -e 'type == "array"' >/dev/null 2>&1; then
    tool_ids_live="$(printf '%s' "$tool_raw" | jq -r '.[].id' | grep -vx interactive_bash | sort)"
    tool_ids_fix="$(jq -r '.tools[].id' "$FIXTURES_DIR/tools.json" | grep -vx interactive_bash | sort)"
    if [ "$tool_ids_live" = "$tool_ids_fix" ]; then
      oqa_v1r_pass "tool list equals the V1 baseline (interactive_bash ignored as envDependent)"
      tools_ok=1
    else
      oqa_v1r_fail "tool list drifted from the V1 baseline (ignoring envDependent tools):"
      printf '%s\n' '--- only in live ---' >&2
      comm -23 <(printf '%s\n' "$tool_ids_live") <(printf '%s\n' "$tool_ids_fix") >&2 || true
      printf '%s\n' '--- only in fixture ---' >&2
      comm -13 <(printf '%s\n' "$tool_ids_live") <(printf '%s\n' "$tool_ids_fix") >&2 || true
    fi
  else
    oqa_v1r_fail "GET /experimental/tool did not return a JSON array"
  fi

  local v2_marker=""
  if grep -q '\[opencode-v2\] engine started' "$work/serve.log" 2>/dev/null; then
    v2_marker="present"
    oqa_v1r_fail "V1 sandbox log carries the [opencode-v2] engine started marker"
  else
    oqa_v1r_pass "no [opencode-v2] engine started marker in the V1 sandbox log"
  fi

  if [ -n "${OQA_V1_EVIDENCE:-}" ]; then
    mkdir -p "$OQA_V1_EVIDENCE"
    cp "$work/serve.log" "$OQA_V1_EVIDENCE/v1-serve.log" 2>/dev/null || true
    cp "$work/agents-live.json" "$OQA_V1_EVIDENCE/agents-live.json" 2>/dev/null || true
  fi
  # The isolated XDG root is not guaranteed to survive oqa_cleanup's temp-dir
  # sweep, and a surviving V1 host child whose environ still carries the root
  # resurrects the tree by re-creating its data dirs on the next write (the
  # same double-fork trap the V2 sandbox library solves with environ
  # matching). Reap those processes first, then remove the root.
  local rp reaped=0
  for rp in $(pgrep -f opencode 2>/dev/null); do
    [ -r "/proc/$rp/environ" ] || continue
    if tr '\0' '\n' < "/proc/$rp/environ" 2>/dev/null | grep -q "^XDG_CONFIG_HOME=$xdg_root/config\$"; then
      kill "$rp" 2>/dev/null || true
      reaped=$((reaped + 1))
    fi
  done
  if [ "$reaped" -gt 0 ]; then
    sleep 1
    for rp in $(pgrep -f opencode 2>/dev/null); do
      [ -r "/proc/$rp/environ" ] || continue
      if tr '\0' '\n' < "/proc/$rp/environ" 2>/dev/null | grep -q "^XDG_CONFIG_HOME=$xdg_root/config\$"; then
        kill -9 "$rp" 2>/dev/null || true
      fi
    done
  fi
  [ -n "${OQA_XDG_ROOT:-}" ] && rm -rf "$OQA_XDG_ROOT"
  OQA_XDG_ROOT=""
  rm -rf "$work"
  rm -f "$dump_before" "$dump_after" "$dump_after.new"

  local tui_ok=1
  if [ "$RUN_TUI" -eq 1 ]; then
    oqa_v1r_log "running tui-smoke.sh..."
    if bash "$SCRIPT_DIR/tui-smoke.sh" > "${OQA_V1_EVIDENCE:-/tmp}/tui-smoke.out" 2>&1; then
      oqa_v1r_pass "tui-smoke.sh passed on the system V1 host"
    else
      oqa_v1r_fail "tui-smoke.sh failed on the system V1 host (output: ${OQA_V1_EVIDENCE:-/tmp}/tui-smoke.out)"
      tui_ok=0
    fi
  fi

  # A surviving TUI/host child resurrects a removed oqa-xdg root the same way
  # the V2 sandbox library's daemon does: after the owner script exits its
  # root is gone, and the orphan re-creates its data dirs on the next write.
  # An orphaned root is one without its home/ dir: oqa_mk_isolated_xdg always
  # creates home/ and never removes it while the owning run is alive, so no
  # live QA run (including a parallel one on this machine) can be matched.
  local qp qroot qorphaned="" swept="" d
  for qp in $(pgrep -f opencode 2>/dev/null); do
    [ -r "/proc/$qp/environ" ] || continue
    qroot="$(tr '\0' '\n' < "/proc/$qp/environ" 2>/dev/null | sed -n 's|^XDG_CONFIG_HOME=\(.*oqa-xdg\.[A-Za-z0-9]\{6\}\)/config$|\1|p')"
    [ -n "$qroot" ] || continue
    [ -d "$qroot/home" ] && continue
    kill "$qp" 2>/dev/null || true
    case " $qorphaned " in *" $qroot "*) ;; *) qorphaned="$qorphaned $qroot" ;; esac
  done
  if [ -n "$qorphaned" ]; then
    sleep 1
    for qp in $(pgrep -f opencode 2>/dev/null); do
      [ -r "/proc/$qp/environ" ] || continue
      qroot="$(tr '\0' '\n' < "/proc/$qp/environ" 2>/dev/null | sed -n 's|^XDG_CONFIG_HOME=\(.*oqa-xdg\.[A-Za-z0-9]\{6\}\)/config$|\1|p')"
      [ -n "$qroot" ] || continue
      case " $qorphaned " in *" $qroot "*) kill -9 "$qp" 2>/dev/null || true ;; esac
    done
    oqa_v1r_log "reaped orphaned oqa-xdg writer(s):$qorphaned"
  fi
  for d in "${TMPDIR:-/tmp}"/oqa-xdg.* /tmp/oqa-xdg.*; do
    [ -d "$d" ] || continue
    [ -d "$d/home" ] && continue
    rm -rf "$d"
    swept="$swept $d"
  done
  [ -n "$swept" ] && oqa_v1r_log "swept orphaned oqa-xdg tree(s):$swept"
  true

  printf 'L-18 %s: V1 regression on system OpenCode (agents %s, tools %s, v2 marker %s, tui %s; GET /agent %ss, GET /experimental/tool %ss)\n' \
    "$([ "$agent_ok" -eq 1 ] && [ "$tools_ok" -eq 1 ] && [ "$v2_marker" = "" ] && [ "$tui_ok" -eq 1 ] && echo PASS || echo FAIL)" \
    "$([ "$agent_ok" -eq 1 ] && echo ok || echo DRIFTED)" \
    "$([ "$tools_ok" -eq 1 ] && echo ok || echo DRIFTED)" \
    "${v2_marker:-absent}" \
    "$([ "$tui_ok" -eq 1 ] && echo ok || echo failed)" \
    "$agent_time" "$tool_time" >&2

  [ "$FAILS" -eq 0 ]
}

oqa_v1r_main
exit $?
