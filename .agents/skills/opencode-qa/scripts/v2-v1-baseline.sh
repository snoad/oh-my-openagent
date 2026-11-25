#!/usr/bin/env bash
# v2-v1-baseline.sh - capture the V1 (system opencode 1.x) behavior baseline
# into deterministic, committed fixtures under
# packages/omo-opencode/src/opencode-v2/parity/fixtures/v1-baseline/.
#
# The SYSTEM opencode (never the OC2 sandbox binary) runs inside the V1
# isolation helper (oqa_mk_isolated_xdg), loads the BUILT plugin through its
# V1 entry the way the other opencode-qa serve scripts do (a
# "plugin": ["file://<repo-root>"] entry in the sandbox opencode.jsonc, which
# resolves package.json exports -> dist/index.js), and the agent + tool lists
# are read through the V1 server API:
#   GET /agent                                                         -> agents
#   GET /experimental/tool?directory=<dir>&provider=..&model=..        -> tools
#
# Fixtures (sorted, no timestamps, ports or absolute sandbox paths):
#   agents.json        [{id, name, mode, hidden, native}] in server order
#                      (id = display name cut at " - ", lowercased)
#   agent-prompts.json {<agent id>: <system prompt>} (reference for byte
#                      equality on OpenCode 2), keys sorted
#   tools.json         {envDependent: {...}, tools: [{id, parameters}]}
#                      sorted by id, key order normalized (jq -S)
#
# Baseline environment notes (documented on purpose):
#   - The sandbox has no provider keys, so model resolution drops the atlas
#     agent entirely. The user-layer omo config ($HOME/.omo/omo.jsonc inside
#     the sandbox, the ONLY config the plugin reads; the legacy
#     $XDG_CONFIG_HOME/opencode/oh-my-openagent.json is not read) pins
#     agents.atlas.model so all 11 omo agents register.
#   - interactive_bash appears only when tmux is on PATH -> marked
#     envDependent in tools.json.
#   - V1 agent `permission` arrays embed absolute sandbox paths, so
#     permission is excluded from the fixtures; prompts contain no sandbox
#     paths (verified) but do embed machine workstation blocks.
#
# Usage:
#   v2-v1-baseline.sh              # capture into the worktree fixtures dir
#   v2-v1-baseline.sh --self-test  # assertions over an existing capture
#   v2-v1-baseline.sh --print-dir  # print the fixtures dir and exit

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/common.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
FIXTURES_DIR="$REPO_ROOT/packages/omo-opencode/src/opencode-v2/parity/fixtures/v1-baseline"
BASELINE_MODEL_PROVIDER="anthropic"
BASELINE_MODEL="claude-opus-5-5"
EXPECTED_AGENTS=(atlas hephaestus librarian metis momus multimodal-looker
  oracle prometheus sisyphus sisyphus-junior explore)

oqa_v1b_log()  { printf '[v2-v1-baseline] %s\n' "$*" >&2; }
oqa_v1b_fail() { printf '[v2-v1-baseline] FAIL: %s\n' "$*" >&2; }

oqa_v1b_require_v1_host() {
  local ver
  ver="$(opencode --version 2>/dev/null | tail -1)"
  case "$ver" in
    1.*) oqa_v1b_log "system opencode is V1 ($ver)" ; return 0 ;;
    *)   oqa_v1b_fail "system opencode version '$ver' does not start with 1."; exit 3 ;;
  esac
}

oqa_v1b_real_db_receipt() {
  local db="$1"
  if [ ! -f "$db" ]; then
    printf 'missing'
    return 0
  fi
  printf '%s sessions=%s' \
    "$(sha256sum "$db" 2>/dev/null | cut -d' ' -f1)" \
    "$(sqlite3 "$db" 'SELECT count(*) FROM session' 2>/dev/null || printf '?')"
}

# Bounded health poll: every curl carries -m (a connected-but-silent server
# otherwise wedges oqa_wait_http's deadline loop) and a dead serve fails fast.
oqa_v1b_wait_health() {
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

oqa_v1b_capture() {
  oqa_require opencode curl jq || return 1
  oqa_v1b_require_v1_host

  if [ ! -f "$REPO_ROOT/dist/index.js" ]; then
    oqa_v1b_fail "dist/index.js not found under $REPO_ROOT (run bun run build first)"
    return 1
  fi

  local real_db real_db_before real_db_after
  real_db="$(oqa_db_path)"
  real_db_before="$(oqa_v1b_real_db_receipt "$real_db")"

  oqa_mk_isolated_xdg || return 1
  mkdir -p "$HOME/.omo"
  printf '{"agents":{"atlas":{"model":"anthropic/claude-sonnet-5"}}}\n' > "$HOME/.omo/omo.jsonc"
  mkdir -p "$XDG_CONFIG_HOME/opencode"
  printf '{\n  "plugin": ["file://%s"]\n}\n' "$REPO_ROOT" > "$XDG_CONFIG_HOME/opencode/opencode.jsonc"

  local neutral="$OQA_XDG_ROOT/neutral"
  mkdir -p "$neutral"

  local port pass
  port="$(oqa_free_port)"
  pass="oqa-v1-baseline"
  (cd "$neutral" && OPENCODE_SERVER_PASSWORD="$pass" exec opencode serve \
      --port "$port" --hostname 127.0.0.1 \
      > "$XDG_STATE_HOME/serve.log" 2>&1 < /dev/null) &
  OQA_SERVER_PID=$!
  disown "$OQA_SERVER_PID" 2>/dev/null || true
  export OQA_SERVER_PORT="$port" OQA_SERVER_PASS="$pass"
  export OQA_SERVER_URL="http://127.0.0.1:$port"

  if ! oqa_v1b_wait_health 90; then
    oqa_v1b_fail "V1 server did not become ready; log follows:"
    cat "$XDG_STATE_HOME/serve.log" >&2 2>/dev/null || true
    return 1
  fi

  local agent_raw tool_raw
  agent_raw="$(curl -s -m 120 -u "opencode:$pass" "$OQA_SERVER_URL/agent")" || agent_raw=""
  if [ -z "$agent_raw" ] || ! printf '%s' "$agent_raw" | jq -e 'type == "array"' >/dev/null 2>&1; then
    oqa_v1b_fail "GET /agent did not return a JSON array"
    return 1
  fi
  tool_raw="$(curl -s -m 60 -u "opencode:$pass" \
    "$OQA_SERVER_URL/experimental/tool?directory=$neutral&provider=$BASELINE_MODEL_PROVIDER&model=$BASELINE_MODEL")" || tool_raw=""
  if [ -z "$tool_raw" ] || ! printf '%s' "$tool_raw" | jq -e 'type == "array"' >/dev/null 2>&1; then
    oqa_v1b_fail "GET /experimental/tool did not return a JSON array"
    return 1
  fi

  oqa_cleanup
  unset OQA_SERVER_PID OQA_SERVER_URL OQA_SERVER_PASS OQA_SERVER_PORT

  real_db_after="$(oqa_v1b_real_db_receipt "$real_db")"
  if [ "$real_db_before" = "$real_db_after" ]; then
    oqa_pass "isolation: real DB unchanged ($real_db_after)"
  else
    oqa_v1b_fail "isolation: real DB changed ($real_db_before -> $real_db_after)"
    return 1
  fi

  mkdir -p "$FIXTURES_DIR"

  printf '%s' "$agent_raw" | jq -S '[.[] | {id: (.name | split(" - ")[0] | ascii_downcase),
      name, mode, hidden, native}]' > "$FIXTURES_DIR/agents.json"
  printf '%s' "$agent_raw" | jq -S 'group_by(.name | split(" - ")[0] | ascii_downcase)
      | map({key: (.[0].name | split(" - ")[0] | ascii_downcase), value: .[0].prompt})
      | from_entries' > "$FIXTURES_DIR/agent-prompts.json"
  printf '%s' "$tool_raw" | jq -S '{envDependent: {interactive_bash: true},
      tools: [.[] | {id, parameters}] | sort_by(.id)}' > "$FIXTURES_DIR/tools.json"

  oqa_v1b_log "wrote $FIXTURES_DIR/agents.json ($(jq 'length' "$FIXTURES_DIR/agents.json") entries)"
  oqa_v1b_log "wrote $FIXTURES_DIR/agent-prompts.json ($(jq 'keys | length' "$FIXTURES_DIR/agent-prompts.json") agents)"
  oqa_v1b_log "wrote $FIXTURES_DIR/tools.json ($(jq '.tools | length' "$FIXTURES_DIR/tools.json") tools)"

  oqa_v1b_verify && return 0
  return 1
}

oqa_v1b_verify() {
  local fails=0 f
  for f in agents.json agent-prompts.json tools.json; do
    if jq -e . "$FIXTURES_DIR/$f" >/dev/null 2>&1; then
      oqa_pass "$f parses as JSON"
    else
      oqa_v1b_fail "$f is not valid JSON"; fails=$((fails+1))
    fi
  done
  local a
  for a in "${EXPECTED_AGENTS[@]}"; do
    if jq -e --arg a "$a" 'map(.id) | index($a) != null' "$FIXTURES_DIR/agents.json" >/dev/null 2>&1; then
      oqa_pass "agents.json contains $a"
    else
      oqa_v1b_fail "agents.json missing $a"; fails=$((fails+1))
    fi
    if jq -e --arg a "$a" 'has($a)' "$FIXTURES_DIR/agent-prompts.json" >/dev/null 2>&1; then
      oqa_pass "agent-prompts.json contains $a"
    else
      oqa_v1b_fail "agent-prompts.json missing $a"; fails=$((fails+1))
    fi
  done
  local leaks
  leaks="$(grep -r "oqa-xdg\|oqa-v2-sandbox\|127.0.0.1:[0-9]" "$FIXTURES_DIR" 2>/dev/null | wc -l)"
  if [ "${leaks:-0}" -eq 0 ]; then
    oqa_pass "fixtures carry no sandbox paths or ports"
  else
    oqa_v1b_fail "fixtures leaked sandbox paths or ports"; fails=$((fails+1))
  fi
  if jq -e '.envDependent.interactive_bash == true' "$FIXTURES_DIR/tools.json" >/dev/null 2>&1; then
    oqa_pass "tools.json marks interactive_bash envDependent"
  else
    oqa_v1b_fail "tools.json envDependent.interactive_bash missing"; fails=$((fails+1))
  fi
  [ "$fails" -eq 0 ] && return 0
  return 1
}

oqa_v1b_self_test() {
  oqa_require opencode curl jq || return 1
  oqa_v1b_require_v1_host
  local fails=0
  if [ ! -f "$FIXTURES_DIR/agents.json" ]; then
    oqa_v1b_fail "no capture yet (run v2-v1-baseline.sh first)"
    return 1
  fi
  oqa_v1b_verify || fails=$((fails+1))

  # determinism: a second capture must be byte-identical
  local tmp saved_dir cap_rc d det_fails=0
  tmp="$(mktemp -d -t oqa-v1b-det.XXXXXX)"
  saved_dir="$FIXTURES_DIR"
  FIXTURES_DIR="$tmp"
  oqa_v1b_capture >/dev/null 2>&1
  cap_rc=$?
  FIXTURES_DIR="$saved_dir"
  if [ "$cap_rc" -eq 0 ]; then
    for d in agents.json agent-prompts.json tools.json; do
      if [ "$(sha256sum "$tmp/$d" | cut -d' ' -f1)" = "$(sha256sum "$FIXTURES_DIR/$d" | cut -d' ' -f1)" ]; then
        oqa_pass "re-capture of $d is byte-identical"
      else
        oqa_v1b_fail "re-capture of $d differs (nondeterministic fixture)"; det_fails=$((det_fails+1))
      fi
    done
  else
    oqa_v1b_fail "second capture run failed"; det_fails=$((det_fails+1))
  fi
  rm -rf "$tmp"
  fails=$((fails+det_fails))

  if [ "$fails" -eq 0 ]; then
    oqa_pass "v2-v1-baseline self-test"
    return 0
  fi
  oqa_v1b_fail "v2-v1-baseline self-test had $fails failure(s)"
  return 1
}

case "${1:-}" in
  --self-test) oqa_v1b_self_test; exit $? ;;
  --print-dir) printf '%s\n' "$FIXTURES_DIR"; exit 0 ;;
  -h|--help)
    sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0 ;;
  "") oqa_v1b_capture; rc=$?; [ "$rc" -eq 0 ] && oqa_pass "v2-v1-baseline capture complete"; exit "$rc" ;;
  *) oqa_v1b_log "unknown argument: $1 (try --help)"; exit 2 ;;
esac
