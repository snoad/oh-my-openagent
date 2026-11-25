#!/usr/bin/env bash
# v2-plugin-probe.sh - prove the omo plugin loads cleanly inside an ISOLATED
# OpenCode 2 sandbox, and that the real (non-sandboxed) host state is
# untouched.
#
# Flow: sandbox pointing at the repo root (expects dist/ built) -> start the
# sandboxed V2 server -> wait for the plugin to appear in GET /api/plugin ->
# stop the server -> print ONE JSON object on stdout:
#   { "pluginIds": [...],
#     "loaded": bool,
#     "loadErrors": [...],
#     "isolation": { "systemVersionBefore", "systemVersionAfter",
#                    "dbDigestBefore", "dbDigestAfter" } }
# loadErrors lists sandboxed log lines carrying role=server together with
# `Plugin must export`, `LoadError` or `error`.
#
# Exit codes: 0 = plugin loaded with no load error; 2 = not loaded (or load
# error); 1 = harness error. The server is always stopped and the sandbox
# always removed (EXIT trap in lib/v2-sandbox.sh).
#
# Usage:
#   v2-plugin-probe.sh               # probe the repo root plugin
#   v2-plugin-probe.sh --self-test   # broken-plugin failure path
#
# Env:
#   OQA_V2_PLUGIN_DIR    plugin dir (default: the repo root of this checkout)
#   OQA_V2_PLUGIN_ID     expected plugin id (default: oh-my-openagent)
#   OQA_V2_PORT          force the serve port (port-conflict QA)
#   OQA_V2_WAIT_PLUGIN   seconds to wait for the plugin (default: 60)
#   OQA_V2_WAIT_READY    seconds to wait for server readiness (default: 30)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/v2-sandbox.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
PLUGIN_DIR="${OQA_V2_PLUGIN_DIR:-$REPO_ROOT}"
PLUGIN_ID="${OQA_V2_PLUGIN_ID:-oh-my-openagent}"
WAIT_PLUGIN="${OQA_V2_WAIT_PLUGIN:-60}"
WAIT_READY="${OQA_V2_WAIT_READY:-30}"

oqa_vp_log()  { printf '[v2-plugin-probe] %s\n' "$*" >&2; }
oqa_vp_fail() { printf '[v2-plugin-probe] FAIL: %s\n' "$*" >&2; }

oqa_vp_main() {
  oqa_require curl jq sqlite3 || return 1

  if [ ! -f "$PLUGIN_DIR/dist/index.js" ]; then
    oqa_vp_fail "dist/index.js not found under $PLUGIN_DIR (run bun run build first)"
    return 1
  fi

  local sys_cmd sys_ver_before sys_ver_after db_before db_after
  sys_cmd="$(command -v opencode)"
  # Resolved before the sandbox rewrites PATH so the after-check never reads
  # the sandbox bin/opencode symlink.
  sys_ver_before="$("$sys_cmd" --version 2>/dev/null | tail -1)"
  db_before="$(oqa_v2_real_db_digest)"

  oqa_v2_mk_sandbox || return 1
  oqa_v2_write_plugin_config "$PLUGIN_DIR" || return 1

  local log_file log_offset
  log_file="$(oqa_v2_log_path)/opencode.log"
  log_offset=0
  [ -f "$log_file" ] && log_offset="$(wc -c < "$log_file" | tr -d ' ')"

  oqa_v2_serve_start || return 1
  if ! oqa_v2_wait_ready "$WAIT_READY"; then
    oqa_vp_log "server did not become ready within ${WAIT_READY}s; serve output follows:"
    cat "$OQA_V2_SANDBOX/serve.out" >&2 2>/dev/null || true
    oqa_v2_serve_stop
    sys_ver_after="$("$sys_cmd" --version 2>/dev/null | tail -1)"
    db_after="$(oqa_v2_real_db_digest)"
    jq -cn \
      --argjson ids '[]' \
      --arg svb "$sys_ver_before" --arg sva "$sys_ver_after" \
      --arg dbb "$db_before" --arg dba "$db_after" \
      '{pluginIds: $ids, loaded: false, loadErrors: ["server did not become ready"],
        isolation: {systemVersionBefore: $svb, systemVersionAfter: $sva,
                    dbDigestBefore: $dbb, dbDigestAfter: $dba}}'
    return 2
  fi

  local loaded=0 plugin_ids="" plugin_resp
  if oqa_v2_wait_plugin "$PLUGIN_ID" "$WAIT_PLUGIN"; then
    loaded=1
  else
    oqa_vp_log "plugin '$PLUGIN_ID' not observed in GET /api/plugin within ${WAIT_PLUGIN}s"
  fi
  plugin_resp="$(oqa_v2_api GET /api/plugin 2>/dev/null)" || plugin_resp=""
  plugin_ids="$(printf '%s' "$plugin_resp" | jq -c '[.data[].id]' 2>/dev/null)" || plugin_ids='[]'

  oqa_v2_serve_stop

  sys_ver_after="$("$sys_cmd" --version 2>/dev/null | tail -1)"
  db_after="$(oqa_v2_real_db_digest)"

  # loadErrors: role=server log lines appended by THIS run that carry
  # `Plugin must export`, `LoadError` or `error`.
  local load_errors
  load_errors="[]"
  if [ -f "$log_file" ]; then
    load_errors="$(tail -c +$((log_offset + 1)) "$log_file" 2>/dev/null \
      | grep 'role=server' \
      | grep -E 'Plugin must export|LoadError|error' \
      | jq -R -s -c 'split("\n") | map(select(length > 0))' 2>/dev/null)" || load_errors="[]"
  fi

  local result rc
  result="$(jq -cn \
    --argjson ids "${plugin_ids:-[]}" \
    --argjson loaded "$([ "$loaded" -eq 1 ] && echo true || echo false)" \
    --argjson errs "$load_errors" \
    --arg svb "$sys_ver_before" --arg sva "$sys_ver_after" \
    --arg dbb "$db_before" --arg dba "$db_after" \
    '{pluginIds: $ids, loaded: $loaded, loadErrors: $errs,
      isolation: {systemVersionBefore: $svb, systemVersionAfter: $sva,
                  dbDigestBefore: $dbb, dbDigestAfter: $dba}}')"
  printf '%s\n' "$result"

  rc=2
  if [ "$loaded" -eq 1 ] && [ "$(printf '%s' "$load_errors" | jq 'length')" -eq 0 ]; then
    rc=0
  fi
  return "$rc"
}

oqa_vp_self_test() {
  local fails=0
  oqa_require curl jq sqlite3 || return 1

  # Broken plugin: package.json with name + exports whose entry
  # default-exports {}. This exact shape reaches the V2 plugin loader.
  local broken
  broken="$(mktemp -d -t oqa-v2-broken.XXXXXX)"
  mkdir -p "$broken/dist"
  printf '%s\n' '{"name":"oqa-broken-plugin","version":"1.0.0","type":"module","exports":{".":"./dist/index.js"}}' \
    > "$broken/package.json"
  printf '%s\n' 'export default {};' > "$broken/dist/index.js"

  local out rc
  out="$(OQA_V2_PLUGIN_DIR="$broken" OQA_V2_PLUGIN_ID="oqa-broken-plugin" \
    OQA_V2_WAIT_PLUGIN="${OQA_V2_WAIT_PLUGIN:-15}" \
    bash "${BASH_SOURCE[0]}" 2>/dev/null)"
  rc=$?
  rm -rf "$broken"

  if [ "$rc" -eq 2 ]; then
    oqa_v2_pass "broken plugin probe exited 2 (got $rc)"
  else
    oqa_v2_fail "broken plugin probe exited $rc (expected 2)"; fails=$((fails+1))
  fi

  local loaded errs
  loaded="$(printf '%s' "$out" | jq -r '.loaded' 2>/dev/null)"
  errs="$(printf '%s' "$out" | jq -r '.loadErrors | length' 2>/dev/null)"
  if [ "$loaded" = "false" ]; then
    oqa_v2_pass "probe JSON reports loaded=false"
  else
    oqa_v2_fail "probe JSON loaded='$loaded' (expected false)"; fails=$((fails+1))
  fi
  if [ "${errs:-0}" -ge 1 ]; then
    oqa_v2_pass "probe JSON reports $errs loadErrors"
  else
    oqa_v2_fail "probe JSON loadErrors empty (expected >= 1)"; fails=$((fails+1))
  fi
  if printf '%s' "$out" | jq -r '.loadErrors[]?' 2>/dev/null | grep -q "Plugin must export a default definition"; then
    oqa_v2_pass "host failure line captured: Plugin must export a default definition with an id and an effect or setup function."
  else
    oqa_v2_fail "host failure line 'Plugin must export a default definition' not captured"; fails=$((fails+1))
  fi
  local dig_b dig_a
  dig_b="$(printf '%s' "$out" | jq -r '.isolation.dbDigestBefore' 2>/dev/null)"
  dig_a="$(printf '%s' "$out" | jq -r '.isolation.dbDigestAfter' 2>/dev/null)"
  if [ -n "$dig_b" ] && [ "$dig_b" = "$dig_a" ]; then
    oqa_v2_pass "isolation: real DB digest identical ($dig_b)"
  else
    oqa_v2_fail "isolation: real DB digest changed ($dig_b -> $dig_a)"; fails=$((fails+1))
  fi

  if [ "$fails" -eq 0 ]; then
    oqa_v2_pass "v2-plugin-probe self-test"
    return 0
  fi
  oqa_v2_fail "v2-plugin-probe self-test had $fails failure(s)"
  return 1
}

case "${1:-}" in
  --self-test) oqa_vp_self_test; exit $? ;;
  -h|--help)
    sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0 ;;
  "") oqa_vp_main; exit $? ;;
  *) oqa_vp_log "unknown argument: $1 (try --help)"; exit 2 ;;
esac
