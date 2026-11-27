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

oqa_v1r_main() {
  oqa_require opencode curl jq sqlite3 || return 1
  oqa_v1r_require_v1_host || return 1
  [ -f "$FIXTURES_DIR/agents.json" ] || { oqa_v1r_fail "v1-baseline fixture missing (run v2-v1-baseline.sh first)"; return 1; }
  [ -f "$REPO_ROOT/dist/index.js" ] || { oqa_v1r_fail "dist/index.js not found (run bun run build first)"; return 1; }

  local real_db before after
  real_db="$(oqa_db_path)"
  before="$(sqlite3 "$real_db" 'SELECT count(*) FROM session' 2>/dev/null || printf '?')"

  oqa_mk_isolated_xdg || return 1
  mkdir -p "$HOME/.omo"
  printf '{"agents":{"atlas":{"model":"anthropic/claude-sonnet-5"}}}\n' > "$HOME/.omo/omo.jsonc"
  mkdir -p "$XDG_CONFIG_HOME/opencode"
  printf '{\n  "plugin": ["file://%s"]\n}\n' "$REPO_ROOT" > "$XDG_CONFIG_HOME/opencode/opencode.jsonc"

  local neutral="$OQA_XDG_ROOT/neutral"
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
    return 1
  fi

  local work
  work="$(mktemp -d -t oqa-v1-regr.XXXXXX)"
  local agent_raw tool_raw agent_curl_rc tool_curl_rc
  agent_raw="$(curl -sS -m 120 -u "opencode:$pass" "$OQA_SERVER_URL/agent" 2>"$work/agent-curl.err")"
  agent_curl_rc=$?
  tool_raw="$(curl -sS -m 60 -u "opencode:$pass" \
    "$OQA_SERVER_URL/experimental/tool?directory=$neutral&provider=$BASELINE_MODEL_PROVIDER&model=$BASELINE_MODEL" 2>"$work/tool-curl.err")"
  tool_curl_rc=$?
  [ "$agent_curl_rc" -eq 0 ] || oqa_v1r_log "GET /agent curl rc=$agent_curl_rc: $(head -c 300 "$work/agent-curl.err" 2>/dev/null)"
  [ "$tool_curl_rc" -eq 0 ] || oqa_v1r_log "GET /experimental/tool curl rc=$tool_curl_rc: $(head -c 300 "$work/tool-curl.err" 2>/dev/null)"

  cp "$XDG_STATE_HOME/serve.log" "$work/serve.log" 2>/dev/null || true
  printf '%s' "$agent_raw" | jq -S '[.[] | {id: (.name | split(" - ")[0] | ascii_downcase),
      name, mode, hidden, native}]' > "$work/agents-live.json" 2>/dev/null || true

  oqa_cleanup
  unset OQA_SERVER_PID OQA_SERVER_URL OQA_SERVER_PASS OQA_SERVER_PORT

  after="$(sqlite3 "$real_db" 'SELECT count(*) FROM session' 2>/dev/null || printf '?')"
  if [ "$before" = "$after" ]; then
    oqa_v1r_pass "isolation: real opencode.db session count unchanged ($after)"
  else
    oqa_v1r_fail "isolation: real opencode.db session count changed ($before -> $after)"
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
  rm -rf "$work"

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

  printf 'L-18 %s: V1 regression on system OpenCode (agents %s, tools %s, v2 marker %s, tui %s)\n' \
    "$([ "$agent_ok" -eq 1 ] && [ "$tools_ok" -eq 1 ] && [ "$v2_marker" = "" ] && [ "$tui_ok" -eq 1 ] && echo PASS || echo FAIL)" \
    "$([ "$agent_ok" -eq 1 ] && echo ok || echo DRIFTED)" \
    "$([ "$tools_ok" -eq 1 ] && echo ok || echo DRIFTED)" \
    "${v2_marker:-absent}" \
    "$([ "$tui_ok" -eq 1 ] && echo ok || echo failed)" >&2

  [ "$FAILS" -eq 0 ]
}

oqa_v1r_main
exit $?
