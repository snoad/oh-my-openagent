#!/usr/bin/env bash
# v2-live-self-test.sh - self-test of v2-parity-live.sh (plan task 20).
#
# Runs V2/parity/live-runner.ts against a tiny stub API (canned responses
# served by lib/v2-live-stub.mjs) and proves PASS and FAIL detection for
# EACH implemented check: one all-good run (every executed row PASS), one
# broken run per check (the targeted row must report FAIL), one post-phase
# run (L-15 PASS on a removed sandbox) plus its broken variant, and the L-22
# process-wide STOP verdict.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"
RUNNER="$REPO_ROOT/packages/omo-opencode/src/opencode-v2/parity/live-runner.ts"
# shellcheck source=common.sh
. "$LIB_DIR/common.sh"

oqa_st_log()  { printf '[v2-live-self-test] %s\n' "$*" >&2; }
oqa_st_pass() { printf 'PASS: %s\n' "$*"; }
oqa_st_fail() { printf 'FAIL: %s\n' "$*" >&2; FAILS=$((FAILS + 1)); return 1; }
FAILS=0

STUB_PID=""
STUB_PORT=""
TMP=""

cleanup() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null || true
  if [ -z "${OQA_ST_KEEP:-}" ]; then
    [ -n "$TMP" ] && rm -rf "$TMP" || true
  else
    oqa_st_log "keeping self-test artifacts at $TMP (OQA_ST_KEEP)"
  fi
  oqa_cleanup
}
trap cleanup EXIT

start_stub() {
  local dir="$1" i
  [ -n "$STUB_PID" ] && { kill "$STUB_PID" 2>/dev/null || true; sleep 0.2; STUB_PID=""; }
  STUB_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()' 2>/dev/null || printf '41000')"
  node "$LIB_DIR/v2-live-stub.mjs" "$STUB_PORT" "$dir" > "$TMP/stub.out" 2>&1 &
  STUB_PID=$!
  for i in $(seq 1 40); do
    curl -sf -m 2 "http://127.0.0.1:$STUB_PORT/health" >/dev/null 2>&1 && return 0
    kill -0 "$STUB_PID" 2>/dev/null || { oqa_st_log "stub died: $(cat "$TMP/stub.out")"; return 1; }
    sleep 0.25
  done
  return 1
}

run_runner() {
  local dir="$1" manifest="$2" out="$3" extra="${4:-}"
  mkdir -p "$out"
  ( cd "$REPO_ROOT" && bun "$RUNNER" --wave 2 --api "http://127.0.0.1:$STUB_PORT" \
      --password stub-pass --plugin-log "$dir/serve.out" --host-log "$dir/host.log" \
      --manifest "$manifest" --out "$out" $extra ) > "$out/runner.out" 2>&1
  return $?
}

row_pass() {
  local results="$1" row="$2"
  jq -r --arg row "$row" '.[] | select(.row == $row) | .pass | if . == true then "true" elif . == false then "false" elif . == "stop" then "stop" else "pending" end' "$results" 2>/dev/null
}

expect_row() {
  local results="$1" row="$2" want="$3" label="$4" got
  got="$(row_pass "$results" "$row")"
  if [ "$got" = "$want" ]; then
    oqa_st_pass "$label: $row is $want"
  else
    oqa_st_fail "$label: $row reported '${got:-missing}' (want $want)"
  fi
}

# ---- canned good data -------------------------------------------------------

write_good_dir() {
  local dir="$1" start first_seen
  mkdir -p "$dir/req-a" "$dir/req-b"
  start="$(date +%s%3N)"
  first_seen=$((start + 3000))
  cat > "$dir/plugin.json" <<JSON
{"location":{"directory":"$dir"},"data":[{"id":"oh-my-openagent","source":{"type":"local","path":"$dir"},"features":{"server":true},"state":{"status":"active"}}]}
JSON
  cat > "$dir/context-ses_stub_b.json" <<'JSON'
{"data":[{"id":"m1","type":"user","text":"Read parity-file.txt"},{"id":"m2","type":"assistant","agent":"build","content":[{"type":"tool","id":"call_1","name":"read","state":{"status":"completed","content":[{"type":"text","text":"Read file /tmp/probe.txt, lines 1-2\n1: hello\n2: world"}]}}]}]}
JSON
  cat > "$dir/context-ses_stub_c.json" <<'JSON'
{"data":[{"id":"m1","type":"user","text":"cat"},{"id":"m2","type":"assistant","agent":"build","content":[{"type":"tool","id":"call_1","name":"shell","state":{"status":"completed","content":[{"type":"text","text":"hello\nworld\n"}]}}]}]}
JSON
  cat > "$dir/serve.out" <<'LOG'
server listening on http://127.0.0.1:1
[opencode-v2] host supported 2.4.1
[oh-my-openagent] ENTRY - plugin loading
[config-migration] startup completed
[opencode-v2] engine started
[opencode-v2] hook chat.message fired
[opencode-v2] hook event fired
[opencode-v2] hook context fired
[opencode-v2] hook experimental.chat.system.transform fired
[opencode-v2] hook experimental.chat.messages.transform fired
[opencode-v2] hook chat.params fired
[opencode-v2] hook chat.headers fired
[opencode-v2] hook tool.execute.before fired
[opencode-v2] hook tool.execute.after fired
[opencode-v2] hook experimental.idle fired
[oh-my-openagent] ENTRY - plugin loading
[config-migration] startup completed
[opencode-v2] engine started
[oh-my-openagent] ENTRY - plugin loading
[config-migration] startup completed
[opencode-v2] engine started
[opencode-v2] [v2-events] session.renamed merged the title of ses_stub_locb into the session info registry
LOG
  cat > "$dir/host.log" <<'LOG'
timestamp=2026-11-27T00:00:00.000Z level=INFO run=1 message="database schema bootstrap started" migrations=64 role=server
timestamp=2026-11-27T00:00:00.100Z level=INFO run=1 message="location services booted" directory=/tmp role=server
LOG
  cat > "$dir/plugin-file.log" <<'LOG'
[bash-file-read-guard] warned on bash file read command {"sessionID":"ses_stub_c","command":"cat /tmp/probe.txt"}
LOG
  cat > "$dir/req-a/requests.jsonl" <<'JSONL'
{"model":"gpt-fake","input":[{"type":"message","role":"developer","content":"You are a host default agent prompt."},{"type":"message","role":"user","content":[{"type":"input_text","text":"Reply with exactly: OQA_A_FINAL"}]}],"tools":[{"type":"function","name":"read"}]}
{"model":"gpt-fake","input":[{"type":"message","role":"developer","content":"You are a host default agent prompt."}],"tools":[]}
JSONL
  cat > "$dir/req-b/requests.jsonl" <<'JSONL'
{"model":"gpt-fake","input":[{"type":"message","role":"developer","content":"You are a host default agent prompt."},{"type":"message","role":"user","content":[{"type":"input_text","text":"Read parity-file.txt"}]}],"tools":[{"type":"function","name":"read"}]}
JSONL
  cat > "$dir/events-a.sse" <<'SSE'
data: {"type":"session.created","data":{"sessionID":"ses_stub_a"}}

data: {"type":"session.execution.completed","data":{"sessionID":"ses_stub_a"}}

data: {"type":"session.renamed","data":{"sessionID":"ses_stub_a"}}

SSE
  cat > "$dir/events-b.sse" <<'SSE'
data: {"type":"session.created","data":{"sessionID":"ses_stub_b"}}

data: {"type":"session.tool.called","data":{"sessionID":"ses_stub_b"}}

data: {"type":"session.step.started","data":{"sessionID":"ses_stub_b"}}

data: {"type":"session.execution.completed","data":{"sessionID":"ses_stub_b"}}

SSE
  printf 'Ask anything\n' > "$dir/tui-smoke.log"
  cat > "$dir/manifest.json" <<JSON
{
  "wave": 2,
  "pluginId": "oh-my-openagent",
  "serverStartEpochMs": $start,
  "pluginFirstSeenEpochMs": $first_seen,
  "scenarios": {
    "a": {"sessionID": "ses_stub_a", "prompt": "Reply with exactly: OQA_A_FINAL", "requestsFile": "$dir/req-a/requests.jsonl", "eventsFile": "$dir/events-a.sse"},
    "b": {"sessionID": "ses_stub_b", "prompt": "Read parity-file.txt", "requestsFile": "$dir/req-b/requests.jsonl", "eventsFile": "$dir/events-b.sse"},
    "c": {"sessionID": "ses_stub_c", "prompt": "Run cat", "requestsFile": "$dir/req-b/requests.jsonl", "eventsFile": "$dir/events-b.sse"}
  },
  "locations": [
    {"name": "serve", "directory": "$dir/serve"},
    {"name": "a", "directory": "$dir/proj-a", "sessionID": "ses_stub_a"},
    {"name": "b", "directory": "$dir/proj-b", "sessionID": "ses_stub_locb"}
  ],
  "tuiSmokeLog": "$dir/tui-smoke.log",
  "pluginFileLog": "$dir/plugin-file.log",
  "sandboxPath": "$dir/sandbox-gone",
  "scriptedSteps": {"a": 1, "b": 2, "c": 2}
}
JSON
  mkdir -p "$dir/sandbox-gone-kept"
  cat > "$dir/post-manifest.json" <<JSON
{
  "wave": 2,
  "pluginId": "oh-my-openagent",
  "serverStartEpochMs": $start,
  "pluginFirstSeenEpochMs": $first_seen,
  "scenarios": {},
  "locations": [],
  "sandboxPath": "$dir/sandbox-gone",
  "isolation": {
    "systemVersionBefore": "1.19.4",
    "systemVersionAfter": "1.19.4",
    "dbDigestBefore": "abc sessions=100",
    "dbDigestAfter": "def sessions=100",
    "sessionCountBefore": 100,
    "sessionCountAfter": 100
  }
}
JSON
}

# Rewrites every $OLD path prefix inside a manifest to the new dir.
rebase_manifest() {
  local manifest="$1" old="$2" new="$3"
  jq --arg old "$old" --arg new "$new" \
    'walk(if type == "string" then sub("^" + $old; $new) else . end)' "$manifest" > "$manifest.tmp"
  mv "$manifest.tmp" "$manifest"
}

# ---- the self-test ----------------------------------------------------------

main() {
  oqa_require node bun jq python3 curl || return 1
  TMP="$(mktemp -d -t oqa-v2-live-st.XXXXXX)"
  local good="$TMP/good"
  write_good_dir "$good"

  # 1. all-good live phase: every executed row PASS, L-15 pending
  start_stub "$good" || { oqa_st_fail "stub did not start"; return 1; }
  run_runner "$good" "$good/manifest.json" "$good/out-live" || true
  local results="$good/out-live/results.json"
  for row in L-01 L-02 L-07 L-08 L-09 L-11 L-20 L-21 L-22 L-24; do
    expect_row "$results" "$row" "true" "good live"
  done
  expect_row "$results" "L-15" "pending" "good live"
  expect_row "$results" "L-18" "pending" "good live"

  # 2. all-good post phase: L-15 PASS
  run_runner "$good" "$good/post-manifest.json" "$good/out-live" "--post" || true
  expect_row "$good/out-live/results.json" "L-15" "true" "good post"

  # 3. broken case per implemented check (targeted row must FAIL)
  broken_case() {
    local row="$1" label="$2" mutation="$3"
    local dir="$TMP/case-$row"
    cp -r "$good" "$dir"
    rm -rf "$dir/out-live" "$dir/sandbox-gone-kept"
    eval "$mutation" >/dev/null 2>&1
    rebase_manifest "$dir/manifest.json" "$good" "$dir"
    rebase_manifest "$dir/post-manifest.json" "$good" "$dir"
    start_stub "$dir" || { oqa_st_fail "$label: stub did not start"; return 1; }
    run_runner "$dir" "$dir/manifest.json" "$dir/out" || true
    expect_row "$dir/out/results.json" "$row" "false" "$label"
  }

  broken_case "L-01" "plugin not active" \
    "jq '.data[0].state.status = \"error\"' '$TMP/case-L-01/plugin.json' > '$TMP/case-L-01/plugin.json.tmp' && mv '$TMP/case-L-01/plugin.json.tmp' '$TMP/case-L-01/plugin.json'"
  broken_case "L-02" "host log carries a plugin error line" \
    "printf '%s\n' 'timestamp=x level=ERROR run=1 message=\"Plugin must export a default definition with an id\" role=server' >> '$TMP/case-L-02/host.log'"
  broken_case "L-07" "chat.message marker missing" \
    "sed -i '/hook chat.message fired/d' '$TMP/case-L-07/serve.out'"
  broken_case "L-08" "system transform marker missing" \
    "sed -i '/hook experimental.chat.system.transform fired/d' '$TMP/case-L-08/serve.out'"
  broken_case "L-09" "guard warn line missing" \
    "sed -i '/bash-file-read-guard/d' '$TMP/case-L-09/plugin-file.log'"
  broken_case "L-11" "session.created missing" \
    "grep -v 'session.created' '$TMP/case-L-11/events-a.sse' > '$TMP/case-L-11/events-a.sse.tmp' && mv '$TMP/case-L-11/events-a.sse.tmp' '$TMP/case-L-11/events-a.sse'"
  broken_case "L-20" "activation over budget" \
    "jq '.pluginFirstSeenEpochMs = .serverStartEpochMs + 61000' '$TMP/case-L-20/manifest.json' > '$TMP/case-L-20/manifest.json.tmp' && mv '$TMP/case-L-20/manifest.json.tmp' '$TMP/case-L-20/manifest.json'"
  broken_case "L-21" "host unsupported line" \
    "printf '%s\n' '[opencode-v2] host unsupported floor 2.3.9' >> '$TMP/case-L-21/serve.out'"
  broken_case "L-22" "engine count mismatch" \
    "sed -i '0,/engine started/{/engine started/d}' '$TMP/case-L-22/serve.out'"
  broken_case "L-24" "no fetch-worthy events" \
    "grep -v -E 'tool.called|step.started' '$TMP/case-L-24/events-b.sse' > '$TMP/case-L-24/events-b.sse.tmp' && mv '$TMP/case-L-24/events-b.sse.tmp' '$TMP/case-L-24/events-b.sse'"

  # 4. L-15 broken post phase: sandbox still exists + session count changed
  local dir="$TMP/case-L-15"
  cp -r "$good" "$dir"
  rm -rf "$dir/out-live"
  rebase_manifest "$dir/post-manifest.json" "$good" "$dir"
  jq --arg sandbox "$dir/sandbox-gone-kept" '.sandboxPath = $sandbox | .isolation.sessionCountAfter = 101' \
    "$dir/post-manifest.json" > "$dir/post-manifest.json.tmp"
  mv "$dir/post-manifest.json.tmp" "$dir/post-manifest.json"
  start_stub "$dir" || { oqa_st_fail "L-15 broken: stub did not start"; return 1; }
  run_runner "$dir" "$dir/post-manifest.json" "$dir/out" "--post" || true
  expect_row "$dir/out/results.json" "L-15" "false" "broken post"

  # 5. L-22 process-wide stream: STOP verdict
  local dir="$TMP/case-L-22-stop"
  cp -r "$good" "$dir"
  rm -rf "$dir/out-live"
  rebase_manifest "$dir/manifest.json" "$good" "$dir"
  printf '%s\n' "[opencode-v2] [v2-events] session.renamed merged the title of ses_stub_locb into the session info registry" >> "$dir/serve.out"
  start_stub "$dir" || { oqa_st_fail "L-22 stop: stub did not start"; return 1; }
  run_runner "$dir" "$dir/manifest.json" "$dir/out" || true
  expect_row "$dir/out/results.json" "L-22" "stop" "process-wide stream"

  if [ "$FAILS" -eq 0 ]; then
    oqa_st_pass "v2-parity-live self-test"
    return 0
  fi
  oqa_st_fail "v2-parity-live self-test had $FAILS failure(s)"
  return 1
}

main
exit $?
