#!/usr/bin/env bash
# v2-live-self-test.sh - self-test of v2-parity-live.sh (plan task 20).
#
# Runs V2/parity/live-runner.ts against a tiny stub API (canned responses
# served by lib/v2-live-stub.mjs) and proves PASS and FAIL detection for
# every implemented check. The stub models the FIXED runtime with the REAL
# 2.4.1 host shapes (task-20 runtime capture): the scenario B read result
# carries hashline LINE# tags as the whole content text ("1#NS|..."), the
# scenario C shell call is the real vetoed envelope
# {"status":"error","content":null,"error":{"type":"unknown","message":...}}
# with the V1 guard message byte-for-byte, and the cleanup stats lines are
# present in serve.out. Coverage:
#   good live run    L-01/L-02/L-03/L-07/L-08/L-09/L-11/L-20/L-21/L-22/L-24
#                    PASS (the stub models the registered state: the agents
#                    captures derive from the V1 baseline fixtures and the
#                    main scenario A request carries the sisyphus system
#                    first line), L-15/L-18 pending
#   good post run    L-15 PASS (ambient sessions tolerated; absent system
#                    opencode = version clause not applicable), L-11 PASS
#                    (stats line, translated > 0), L-24 PASS (bound holds)
#   broken runs      one targeted mutation per FAIL case (see the case list
#                    in main) plus the L-08 full-strength PASS case, the
#                    L-15 absent-opencode PASS case (with its evidence line)
#                    and the L-15 version-changed FAIL case, and the L-22
#                    process-wide STOP verdict
#   driver tests     truthful final line, --strict gate, L-18 verdict
#                    write-back, bun/ junk guard, reload-for-stats trigger
#                    (step 1, step 2, never) (driver sourced in import mode;
#                    no OC2 dependency)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"
RUNNER="$REPO_ROOT/packages/omo-opencode/src/opencode-v2/parity/live-runner.ts"
FIXTURES_ROOT="$REPO_ROOT/packages/omo-opencode/src/opencode-v2/parity/fixtures/v1-baseline"
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
  ( cd "$REPO_ROOT" && bun "$RUNNER" --wave 3 --api "http://127.0.0.1:$STUB_PORT" \
      --password stub-pass --plugin-log "$dir/serve.out" --host-log "$dir/host.log" \
      --manifest "$manifest" --out "$out" $extra ) > "$out/runner.out" 2>&1
  return $?
}

row_pass() {
  local results="$1" row="$2"
  jq -r --arg row "$row" '.[] | select(.row == $row) | .pass |
    if . == true then "true" elif . == false then "false" elif . == "partial" then "partial"
    elif . == "stop" then "stop" else "pending" end' "$results" 2>/dev/null
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

# ---- canned good data (models the FIXED runtime) ----------------------------

GUARD_MESSAGE="Prefer the Read tool over \`cat\`/\`head\`/\`tail\` for reading file contents. The Read tool provides line numbers and hash anchors for precise editing."

# Rewrites the stats line of <projdir> inside a serve.out copy.
oqa_st_set_stats() {
  local f="$1" pd="$2" es="$3" tr="$4" fw="$5" cb="$6" cf="$7" cff="$8"
  local prefix='[opencode-v2] event stats '
  local newline="${prefix}{\"directory\":\"$pd\",\"eventsSeen\":$es,\"translated\":$tr,\"fetchWorthy\":$fw,\"coalesceBatches\":$cb,\"contextFetches\":$cf,\"contextFetchFailures\":$cff}"
  awk -v pd="$pd" -v nl="$newline" -v px="$prefix" '
    index($0, px) == 1 {
      tail = substr($0, length(px) + 1)
      if (index(tail, "{\"directory\":\"" pd "\"") == 1) { print nl; next }
    }
    { print }
  ' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
}

oqa_st_del_stats_lines() { sed -i '/^\[opencode-v2\] event stats /d' "$1"; }

oqa_st_write_ctx_b_notag() {
  cat > "$1/context-ses_stub_b.json" <<'JSON'
{"data":[{"id":"m1","type":"user","text":"Read parity-file.txt"},{"id":"m2","type":"assistant","agent":"build","content":[{"type":"tool","id":"call_1","name":"read","state":{"status":"completed","content":[{"type":"text","text":"Read file /tmp/probe.txt, lines 1-2\n1: hello\n2: world"}]}}]}]}
JSON
}

oqa_st_write_ctx_c_plain() {
  cat > "$1/context-ses_stub_c.json" <<'JSON'
{"data":[{"id":"m1","type":"user","text":"cat"},{"id":"m2","type":"assistant","agent":"build","content":[{"type":"tool","id":"call_1","name":"shell","state":{"status":"completed","content":[{"type":"text","text":"parity row nine file\nsecond line\n"}]}}]}]}
JSON
}

oqa_st_write_ctx_c_leak() {
  cat > "$1/context-ses_stub_c.json" <<JSON
{"data":[{"id":"m1","type":"user","text":"cat"},{"id":"m2","type":"assistant","agent":"build","content":[{"type":"tool","id":"call_1","name":"shell","state":{"status":"error","content":null,"error":{"type":"unknown","message":"$GUARD_MESSAGE\nparity row nine file\nsecond line"}}}]}]}
JSON
}

oqa_st_write_ctx_c_executed() {
  cat > "$1/context-ses_stub_c.json" <<JSON
{"data":[{"id":"m1","type":"user","text":"cat"},{"id":"m2","type":"assistant","agent":"build","content":[{"type":"tool","id":"call_1","name":"shell","state":{"status":"completed","content":[{"type":"text","text":"parity row nine file\nsecond line"}]}}]}]}
JSON
}

oqa_st_sisyphus_first_line() {
  jq -r '.sisyphus' "$FIXTURES_ROOT/agent-prompts.json" 2>/dev/null | head -1
}

write_good_dir() {
  local dir="$1" start first_seen
  mkdir -p "$dir/req-a" "$dir/req-b" "$dir/proj-a" "$dir/proj-b"
  start="$(date +%s%3N)"
  first_seen=$((start + 3000))
  cat > "$dir/plugin.json" <<JSON
{"location":{"directory":"$dir"},"data":[{"id":"oh-my-openagent","source":{"type":"local","path":"$dir"},"features":{"server":true},"state":{"status":"active"}}]}
JSON
  cat > "$dir/context-ses_stub_b.json" <<JSON
{"data":[{"id":"m1","type":"user","text":"Read parity-file.txt"},{"id":"m2","type":"assistant","agent":"build","content":[{"type":"tool","id":"call_1","name":"read","state":{"status":"completed","input":{"path":"$dir/proj-a/parity-file.txt"},"content":[{"type":"text","text":"1#NS|parity row nine file\n2#HP|second line"}],"metadata":{"truncated":false}}}]}]}
JSON
  cat > "$dir/context-ses_stub_c.json" <<JSON
{"data":[{"id":"m1","type":"user","text":"cat"},{"id":"m2","type":"assistant","agent":"build","content":[{"type":"tool","id":"call_1","name":"shell","state":{"status":"error","input":{"command":"cat $dir/proj-a/parity-file.txt"},"content":null,"error":{"type":"unknown","message":"$GUARD_MESSAGE"}}}]}]}
JSON
  cat > "$dir/serve.out" <<LOG
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
[opencode-v2] event stats {"directory":"$dir/proj-a","eventsSeen":42,"translated":40,"fetchWorthy":10,"coalesceBatches":2,"contextFetches":11,"contextFetchFailures":0}
[opencode-v2] event stats {"directory":"$dir/proj-b","eventsSeen":9,"translated":9,"fetchWorthy":3,"coalesceBatches":1,"contextFetches":3,"contextFetchFailures":0}
LOG
  cat > "$dir/host.log" <<'LOG'
timestamp=2026-11-27T00:00:00.000Z level=INFO run=1 message="database schema bootstrap started" migrations=64 role=server
timestamp=2026-11-27T00:00:00.100Z level=INFO run=1 message="location services booted" directory=/tmp role=server
LOG
  cat > "$dir/plugin-file.log" <<'LOG'
[bash-file-read-guard] warned on bash file read command {"sessionID":"ses_stub_c","command":"cat /tmp/probe.txt"}
LOG
  # The registered state: the main scenario A request (tools non-empty)
  # carries the default agent's (sisyphus) system first line as the developer
  # content; the aux request keeps the host placeholder.
  local sisyphus_line
  sisyphus_line="$(oqa_st_sisyphus_first_line)"
  jq -n --arg line "$sisyphus_line" -c '({
    model: "gpt-fake",
    input: [
      {type: "message", role: "developer", content: $line},
      {type: "message", role: "user", content: [{type: "input_text", text: "Reply with exactly: OQA_A_FINAL"}]}
    ],
    tools: [{type: "function", name: "read"}]
  }), ({
    model: "gpt-fake",
    input: [{type: "message", role: "developer", content: "You are a host default agent prompt."}],
    tools: []
  })' > "$dir/req-a/requests.jsonl"
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

  # The registered-state agent captures (L-03): derived from the committed V1
  # baseline fixtures, one entry per unique baseline id with the visible row's
  # flags and the fixture prompt bytes; the after capture adds the hot agent.
  # The real 2.4.1 GET /api/agent answer lists agents in insertion order, so
  # the stub keeps the fixture row order (the reduce dedupe preserves first
  # hits; group_by/unique_by would sort and break the L-03 order assertion).
  jq -c '[.[] | select(.hidden != true or .native == true)]
    | reduce .[] as $row ([]; if ([.[] | .id] | index($row.id)) == null then . + [$row] else . end)
    | .[] | {id, name, mode, hidden: (.hidden == true), request: {}}' \
    "$FIXTURES_ROOT/agents.json" > "$dir/agents-rows.jsonl"
  jq -R -s 'split("\n") | map(select(length > 0) | fromjson)' "$dir/agents-rows.jsonl" > "$dir/agents-rows.json"
  # The real 2.4.1 GET /api/agent answer shape is the {data: [...]} envelope.
  jq -c --slurpfile prompts "$FIXTURES_ROOT/agent-prompts.json" \
    '{data: map(. + {system: ($prompts[0][.id] // null), permissions: []})}' "$dir/agents-rows.json" > "$dir/agents-before.json"
  jq -c '.data + [{"id":"oqa-hot-agent","name":"Oqa-Hot-Agent","mode":"subagent","hidden":false,"system":"hot probe prompt","permissions":[]}] | {data: .}' \
    "$dir/agents-before.json" > "$dir/agents-after.json"
  cp "$dir/agents-before.json" "$dir/agents.json"
  rm -f "$dir/agents-rows.jsonl" "$dir/agents-rows.json"
  local before_count after_count
  before_count="$(jq '.data | length' "$dir/agents-before.json")"
  after_count="$(jq '.data | length' "$dir/agents-after.json")"
  [ "$before_count" -gt 0 ] || { oqa_st_log "agents-before capture is empty"; return 1; }

  cat > "$dir/manifest.json" <<JSON
{
  "wave": 2,
  "pluginId": "oh-my-openagent",
  "serverStartEpochMs": $start,
  "pluginFirstSeenEpochMs": $first_seen,
  "scenarios": {
    "a": {"sessionID": "ses_stub_a", "prompt": "Reply with exactly: OQA_A_FINAL", "requestsFile": "$dir/req-a/requests.jsonl", "eventsFile": "$dir/events-a.sse", "directory": "$dir/proj-a"},
    "b": {"sessionID": "ses_stub_b", "prompt": "Read parity-file.txt", "requestsFile": "$dir/req-b/requests.jsonl", "eventsFile": "$dir/events-b.sse", "directory": "$dir/proj-a"},
    "c": {"sessionID": "ses_stub_c", "prompt": "Run cat", "requestsFile": "$dir/req-b/requests.jsonl", "eventsFile": "$dir/events-b.sse", "directory": "$dir/proj-a", "file": "$dir/proj-a/parity-file.txt", "fileContent": "parity row nine file\nsecond line\n"}
  },
  "locations": [
    {"name": "serve", "directory": "$dir/serve"},
    {"name": "a", "directory": "$dir/proj-a", "sessionID": "ses_stub_a"},
    {"name": "b", "directory": "$dir/proj-b", "sessionID": "ses_stub_locb"}
  ],
  "tuiSmokeLog": "$dir/tui-smoke.log",
  "pluginFileLog": "$dir/plugin-file.log",
  "agentsBeforeFile": "$dir/agents-before.json",
  "agentsAfterFile": "$dir/agents-after.json",
  "hotAgentId": "oqa-hot-agent",
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
  "scenarios": {
    "a": {"sessionID": "ses_stub_a", "prompt": "Reply with exactly: OQA_A_FINAL", "requestsFile": "$dir/req-a/requests.jsonl", "eventsFile": "$dir/events-a.sse", "directory": "$dir/proj-a"},
    "b": {"sessionID": "ses_stub_b", "prompt": "Read parity-file.txt", "requestsFile": "$dir/req-b/requests.jsonl", "eventsFile": "$dir/events-b.sse", "directory": "$dir/proj-a"},
    "c": {"sessionID": "ses_stub_c", "prompt": "Run cat", "requestsFile": "$dir/req-b/requests.jsonl", "eventsFile": "$dir/events-b.sse", "directory": "$dir/proj-a", "file": "$dir/proj-a/parity-file.txt", "fileContent": "parity row nine file\nsecond line\n"}
  },
  "locations": [],
  "pluginFileLog": "$dir/plugin-file.log",
  "agentsBeforeFile": "$dir/agents-before.json",
  "agentsAfterFile": "$dir/agents-after.json",
  "hotAgentId": "oqa-hot-agent",
  "sandboxPath": "$dir/sandbox-gone",
  "isolation": {
    "systemVersionBefore": "1.19.4",
    "systemVersionAfter": "1.19.4",
    "dbDigestBefore": "abc sessions=100",
    "dbDigestAfter": "def sessions=103",
    "sessionCountBefore": 100,
    "sessionCountAfter": 103,
    "method": "sqlite3 id+directory diff of the real opencode.db before/after the run; leak = new session row whose directory is inside the sandbox path",
    "leakedSessionDirectories": [],
    "ambientSessionDirectories": ["$dir/ambient-proj-x", "$dir/ambient-proj-y"]
  }
}
JSON
}

# Rewrites every $OLD path prefix inside the manifests and the serve.out
# stats directories to the new dir.
rebase_case() {
  local dir="$1" old="$2" new="$3"
  for f in "$dir/manifest.json" "$dir/post-manifest.json"; do
    jq --arg old "$old" --arg new "$new" \
      'walk(if type == "string" then sub("^" + $old; $new) else . end)' "$f" > "$f.tmp"
    mv "$f.tmp" "$f"
  done
  sed -i "s|$old|$new|g" "$dir/serve.out"
}

# ---- the self-test ----------------------------------------------------------

main() {
  oqa_require node bun jq python3 curl || return 1
  TMP="$(mktemp -d -t oqa-v2-live-st.XXXXXX)"
  local good="$TMP/good"
  write_good_dir "$good"

  # 1. all-good live phase: executed rows PASS, L-15/L-18 pending
  start_stub "$good" || { oqa_st_fail "stub did not start"; return 1; }
  run_runner "$good" "$good/manifest.json" "$good/out-live" || true
  local results="$good/out-live/results.json"
  for row in L-01 L-02 L-03 L-07 L-08 L-09 L-11 L-20 L-21 L-22 L-24; do
    expect_row "$results" "$row" "true" "good live"
  done
  expect_row "$results" "L-15" "pending" "good live"
  expect_row "$results" "L-18" "pending" "good live"

  # 2. all-good post phase: L-15 PASS (ambient tolerated), L-11/L-24 PASS
  run_runner "$good" "$good/post-manifest.json" "$good/out-live" "--post" || true
  expect_row "$good/out-live/results.json" "L-15" "true" "good post"
  expect_row "$good/out-live/results.json" "L-11" "true" "good post"
  expect_row "$good/out-live/results.json" "L-24" "true" "good post"

  # 3. broken case per strictened check (targeted row must FAIL).
  #    post=1 runs live then post so the cleanup-stats gates are evaluated.
  broken_case() {
    local row="$1" label="$2" mutation="$3" post="${4:-0}" want="false"
    local dir="$TMP/case-$row-$label"
    cp -r "$good" "$dir"
    rm -rf "$dir/out-live" "$dir/out" "$dir/sandbox-gone-kept"
    rebase_case "$dir" "$good" "$dir"
    eval "$mutation" >/dev/null 2>&1
    start_stub "$dir" || { oqa_st_fail "$label: stub did not start"; return 1; }
    run_runner "$dir" "$dir/manifest.json" "$dir/out" || true
    if [ "$post" = "1" ]; then
      run_runner "$dir" "$dir/post-manifest.json" "$dir/out" "--post" || true
    fi
    expect_row "$dir/out/results.json" "$row" "$want" "$label"
  }

  broken_case "L-01" "plugin-not-active" \
    "jq '.data[0].state.status = \"error\"' '$TMP/case-L-01-plugin-not-active/plugin.json' > '$TMP/x.json' && mv '$TMP/x.json' '$TMP/case-L-01-plugin-not-active/plugin.json'"
  broken_case "L-02" "plugin-error-line" \
    "printf '%s\n' 'timestamp=x level=ERROR run=1 message=\"Plugin must export a default definition with an id\" role=server' >> '$TMP/case-L-02-plugin-error-line/host.log'"
  broken_case "L-07" "chat-marker-missing" \
    "sed -i '/hook chat.message fired/d' '$TMP/case-L-07-chat-marker-missing/serve.out'"
  broken_case "L-08" "system-marker-missing" \
    "sed -i '/hook experimental.chat.system.transform fired/d' '$TMP/case-L-08-system-marker-missing/serve.out'"

  # The L-08 full-strength PASS is the good live run itself since the stub
  # models the registered state (the sisyphus first line is in the main
  # request). L-03 FAIL cases: a baseline agent dropped from the after
  # capture, a mutated prompt byte, and the missing after-capture manifest
  # entry ("not proven" never passes).
  broken_case "L-03" "after-agent-dropped" \
    "jq '.data |= map(select(.id != \"librarian\"))' '$TMP/case-L-03-after-agent-dropped/agents-after.json' > '$TMP/x.json' && mv '$TMP/x.json' '$TMP/case-L-03-after-agent-dropped/agents-after.json'"
  broken_case "L-03" "after-prompt-byte-mutated" \
    "jq '(.data[] | select(.id == \"sisyphus\") | .system) |= (.[0:8] + \"XX\" + .[10:])' '$TMP/case-L-03-after-prompt-byte-mutated/agents-after.json' > '$TMP/x.json' && mv '$TMP/x.json' '$TMP/case-L-03-after-prompt-byte-mutated/agents-after.json'"
  broken_case "L-03" "after-capture-missing" \
    "jq 'del(.agentsAfterFile)' '$TMP/case-L-03-after-capture-missing/manifest.json' > '$TMP/x.json' && mv '$TMP/x.json' '$TMP/case-L-03-after-capture-missing/manifest.json'"

  broken_case "L-09" "read-tag-missing" \
    "oqa_st_write_ctx_b_notag '$TMP/case-L-09-read-tag-missing'"
  broken_case "L-09" "guard-text-missing" \
    "oqa_st_write_ctx_c_plain '$TMP/case-L-09-guard-text-missing'"
  broken_case "L-09" "file-content-leak-via-error-text" \
    "oqa_st_write_ctx_c_leak '$TMP/case-L-09-file-content-leak-via-error-text'"
  broken_case "L-09" "cat-executed-completed" \
    "oqa_st_write_ctx_c_executed '$TMP/case-L-09-cat-executed-completed'"
  broken_case "L-09" "file-content-missing" \
    "jq 'del(.scenarios.c.fileContent)' '$TMP/case-L-09-file-content-missing/manifest.json' > '$TMP/x.json' && mv '$TMP/x.json' '$TMP/case-L-09-file-content-missing/manifest.json'"
  broken_case "L-11" "stats-line-missing" \
    "oqa_st_del_stats_lines '$TMP/case-L-11-stats-line-missing/serve.out'" 1
  broken_case "L-11" "translated-zero" \
    "oqa_st_set_stats '$TMP/case-L-11-translated-zero/serve.out' '$TMP/case-L-11-translated-zero/proj-a' 42 0 10 2 11 0" 1
  broken_case "L-20" "activation-over-budget" \
    "jq '.pluginFirstSeenEpochMs = .serverStartEpochMs + 61000' '$TMP/case-L-20-activation-over-budget/manifest.json' > '$TMP/x.json' && mv '$TMP/x.json' '$TMP/case-L-20-activation-over-budget/manifest.json'"
  broken_case "L-21" "host-unsupported" \
    "printf '%s\n' '[opencode-v2] host unsupported floor 2.3.9' >> '$TMP/case-L-21-host-unsupported/serve.out'"
  broken_case "L-22" "engine-count-mismatch" \
    "sed -i '0,/engine started/{/engine started/d}' '$TMP/case-L-22-engine-count-mismatch/serve.out'"
  broken_case "L-24" "no-fetch-worthy" \
    "grep -v -E 'tool.called|step.started' '$TMP/case-L-24-no-fetch-worthy/events-b.sse' > '$TMP/x.sse' && mv '$TMP/x.sse' '$TMP/case-L-24-no-fetch-worthy/events-b.sse'"
  broken_case "L-24" "stats-line-missing" \
    "oqa_st_del_stats_lines '$TMP/case-L-24-stats-line-missing/serve.out'" 1
  broken_case "L-24" "bound-violated" \
    "oqa_st_set_stats '$TMP/case-L-24-bound-violated/serve.out' '$TMP/case-L-24-bound-violated/proj-a' 42 40 10 2 999 0" 1

  # 4. L-15 broken post phases: sandbox still exists, and a real leak row.
  local dir="$TMP/case-L-15-sandbox"
  cp -r "$good" "$dir"; rm -rf "$dir/out-live" "$dir/out"
  rebase_case "$dir" "$good" "$dir"
  jq --arg sandbox "$dir/sandbox-gone-kept" '.sandboxPath = $sandbox' \
    "$dir/post-manifest.json" > "$dir/pm.tmp" && mv "$dir/pm.tmp" "$dir/post-manifest.json"
  start_stub "$dir" || { oqa_st_fail "L-15 sandbox: stub did not start"; return 1; }
  run_runner "$dir" "$dir/post-manifest.json" "$dir/out" "--post" || true
  expect_row "$dir/out/results.json" "L-15" "false" "L-15 sandbox still exists"

  dir="$TMP/case-L-15-leak"
  cp -r "$good" "$dir"; rm -rf "$dir/out-live" "$dir/out"
  rebase_case "$dir" "$good" "$dir"
  jq --arg d "$dir/sandbox-gone/leaked-session" '.isolation.leakedSessionDirectories = [$d]' \
    "$dir/post-manifest.json" > "$dir/pm.tmp" && mv "$dir/pm.tmp" "$dir/post-manifest.json"
  start_stub "$dir" || { oqa_st_fail "L-15 leak: stub did not start"; return 1; }
  run_runner "$dir" "$dir/post-manifest.json" "$dir/out" "--post" || true
  expect_row "$dir/out/results.json" "L-15" "false" "L-15 real leak row"

  # 4b. L-15 absent-opencode post phase: no system opencode on the runner,
  # version clause not applicable, leak clauses unchanged -> PASS with the
  # truthful evidence line.
  dir="$TMP/case-L-15-absent"
  cp -r "$good" "$dir"; rm -rf "$dir/out-live" "$dir/out"
  rebase_case "$dir" "$good" "$dir"
  jq '.isolation.systemOpencode = "absent" | .isolation.systemVersionBefore = null | .isolation.systemVersionAfter = null' \
    "$dir/post-manifest.json" > "$dir/pm.tmp" && mv "$dir/pm.tmp" "$dir/post-manifest.json"
  start_stub "$dir" || { oqa_st_fail "L-15 absent: stub did not start"; return 1; }
  run_runner "$dir" "$dir/post-manifest.json" "$dir/out" "--post" || true
  expect_row "$dir/out/results.json" "L-15" "true" "L-15 absent system opencode"
  if grep -qF 'system opencode: absent on this runner (version clause not applicable)' "$dir/out/L-15.txt" 2>/dev/null; then
    oqa_st_pass "L-15 absent: evidence states the version clause is not applicable"
  else
    oqa_st_fail "L-15 absent: evidence line missing from $dir/out/L-15.txt"
  fi

  # 4c. L-15 version-changed post phase: system opencode present with
  # unequal versions must still FAIL (the present-path branch is untouched).
  dir="$TMP/case-L-15-version-changed"
  cp -r "$good" "$dir"; rm -rf "$dir/out-live" "$dir/out"
  rebase_case "$dir" "$good" "$dir"
  jq '.isolation.systemOpencode = "present" | .isolation.systemVersionAfter = "2.4.1"' \
    "$dir/post-manifest.json" > "$dir/pm.tmp" && mv "$dir/pm.tmp" "$dir/post-manifest.json"
  start_stub "$dir" || { oqa_st_fail "L-15 version-changed: stub did not start"; return 1; }
  run_runner "$dir" "$dir/post-manifest.json" "$dir/out" "--post" || true
  expect_row "$dir/out/results.json" "L-15" "false" "L-15 version changed"

  # 5. L-22 process-wide stream: STOP verdict
  dir="$TMP/case-L-22-stop"
  cp -r "$good" "$dir"; rm -rf "$dir/out-live" "$dir/out"
  rebase_case "$dir" "$good" "$dir"
  printf '%s\n' "[opencode-v2] [v2-events] session.renamed merged the title of ses_stub_locb into the session info registry" >> "$dir/serve.out"
  start_stub "$dir" || { oqa_st_fail "L-22 stop: stub did not start"; return 1; }
  run_runner "$dir" "$dir/manifest.json" "$dir/out" || true
  expect_row "$dir/out/results.json" "L-22" "stop" "process-wide stream"

  # 6. driver-level tests: verdict table, strict gate, L-18 verdict, bun guard
  driver_tests "$good"

  if [ "$FAILS" -eq 0 ]; then
    oqa_st_pass "v2-parity-live self-test"
    return 0
  fi
  oqa_st_fail "v2-parity-live self-test had $FAILS failure(s)"
  return 1
}

# Driver tests: source v2-parity-live.sh in import mode (no OC2 dependency,
# no trap overwrite) and exercise the verdict/strict/L-18/bun-guard logic.
# The driver shares the FAILS counter with this shell, so the driver tests
# track their own counter and the shared FAILS is restored afterwards.
driver_tests() {
  local good="$1" self_fails=$FAILS driver_fails=0 out rc
  bad() { printf 'FAIL: %s\n' "$*" >&2; driver_fails=$((driver_fails + 1)); }
  FAILS=0
  OQA_PL_IMPORT_FOR_TEST=1 . "$SCRIPT_DIR/../v2-parity-live.sh"

  # 6a. truthful final line: open rows present -> no "every executed live
  # row passed" claim; every open row of wave <= N named with its owner.
  mkdir -p "$TMP/dt"
  jq -n '[{"row":"L-01","wave":2,"pass":true,"summary":"x"},
           {"row":"L-08","wave":2,"pass":"partial","owner":"agent registration, plan task 24; re-proven by IS-5","summary":"x"},
           {"row":"L-18","wave":2,"pass":"pending","owner":"v2-v1-regression.sh (stays pending with --skip-v1)","summary":"x"},
           {"row":"L-22","wave":2,"pass":"stop","owner":"per-location event stream isolation (recorded limit; re-proven when the isolation lands)","summary":"x"},
           {"row":"L-03","wave":3,"pass":"pending","owner":"agent registration lands with plan task 24 (wave 3)","summary":"x"}]' \
    > "$TMP/dt/results.json"
  EV_LIVE="$TMP/dt" WAVE=2 STRICT=0
  out="$(oqa_pl_print_table)"; rc=$?
  open="$(printf '%s' "$out" | grep '^OPEN ROWS REMAIN' || true)"
  if [ "$rc" -eq 0 ] && printf '%s' "$open" | grep -qF 'OPEN ROWS REMAIN (wave <= 2)' \
     && printf '%s' "$out" | grep -qF 'partial L-08 owner: agent registration, plan task 24' \
     && printf '%s' "$out" | grep -qF 'pending L-18 owner: v2-v1-regression.sh' \
     && printf '%s' "$out" | grep -qF 'stop L-22 owner: per-location event stream isolation' \
     && ! printf '%s' "$open" | grep -qF 'L-03' \
     && ! printf '%s' "$out" | grep -qF 'every executed live row passed'; then
    oqa_st_pass "driver: final line names open rows with owners and never claims all passed"
  else
    bad "driver: final line wrong for the open-rows table (rc=$rc)"; driver_fails=$((driver_fails + 1))
  fi

  # 6b. truthful final line: no open rows -> the all-passed claim.
  jq -n '[{"row":"L-01","wave":2,"pass":true,"summary":"x"},{"row":"L-24","wave":2,"pass":true,"summary":"x"}]' \
    > "$TMP/dt/results.json"
  out="$(oqa_pl_print_table)"; rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qF 'PASS: every executed live row passed'; then
    oqa_st_pass "driver: clean table prints the every-row-passed claim"
  else
    bad "driver: clean table missing the every-row-passed claim (rc=$rc)"; driver_fails=$((driver_fails + 1))
  fi

  # 6c. strict gate: open wave<=N rows fail under --strict only.
  jq -n '[{"row":"L-08","wave":2,"pass":"partial","owner":"o","summary":"x"}]' > "$TMP/dt/results.json"
  EV_LIVE="$TMP/dt" WAVE=2 STRICT=1
  if oqa_pl_strict_gate; then
    bad "driver: strict gate passed despite an open wave-2 row"; driver_fails=$((driver_fails + 1))
  else
    oqa_st_pass "driver: strict gate fails on an open wave-2 row"
  fi
  STRICT=0
  if oqa_pl_strict_gate; then
    oqa_st_pass "driver: non-strict gate tolerates open rows"
  else
    bad "driver: non-strict gate failed on open rows"; driver_fails=$((driver_fails + 1))
  fi
  jq -n '[{"row":"L-08","wave":2,"pass":true,"summary":"x"}]' > "$TMP/dt/results.json"
  STRICT=1
  if oqa_pl_strict_gate; then
    oqa_st_pass "driver: strict gate passes with no open rows"
  else
    bad "driver: strict gate failed on a clean table"; driver_fails=$((driver_fails + 1))
  fi

  # 6d. L-18 verdict write-back into results.json.
  mkdir -p "$TMP/dt2"
  jq -n '[{"row":"L-18","wave":2,"pass":"pending","owner":"v2-v1-regression.sh","summary":"pending","evidence":"e"}]' \
    > "$TMP/dt2/results.json"
  printf 'PASS: tui\nL-18 PASS: V1 regression on system OpenCode (agents ok, tools ok, v2 marker absent, tui ok)\n' > "$TMP/dt2/v1-regression.out"
  EV_LIVE="$TMP/dt2" oqa_pl_apply_v1_verdict "$TMP/dt2/v1-regression.out"
  if [ "$(jq -r '.[] | select(.row == "L-18") | .pass' "$TMP/dt2/results.json")" = "true" ] \
     && [ "$(jq -r '.[] | select(.row == "L-18") | .evidence' "$TMP/dt2/results.json")" = "$TMP/dt2/v1-regression.out" ]; then
    oqa_st_pass "driver: L-18 PASS verdict written into results.json"
  else
    bad "driver: L-18 PASS verdict not applied"; driver_fails=$((driver_fails + 1))
  fi
  printf 'L-18 FAIL: V1 regression on system OpenCode (agents DRIFTED, tools ok, v2 marker absent, tui ok)\n' > "$TMP/dt2/v1-regression.out"
  EV_LIVE="$TMP/dt2" oqa_pl_apply_v1_verdict "$TMP/dt2/v1-regression.out"
  if [ "$(jq -r '.[] | select(.row == "L-18") | .pass' "$TMP/dt2/results.json")" = "false" ]; then
    oqa_st_pass "driver: L-18 FAIL verdict written into results.json"
  else
    bad "driver: L-18 FAIL verdict not applied"; driver_fails=$((driver_fails + 1))
  fi

  # 6e. bun/ junk guard: FAIL only when bun/ appeared and was absent before.
  mkdir -p "$TMP/dtrepo"
  REPO_ROOT="$TMP/dtrepo" REPO_BUN_DIR_BEFORE="0"
  if oqa_pl_bun_junk_check; then
    oqa_st_pass "driver: no bun/ junk when the directory is absent"
  else
    bad "driver: bun guard tripped without junk"; driver_fails=$((driver_fails + 1))
  fi
  mkdir -p "$TMP/dtrepo/bun"
  if oqa_pl_bun_junk_check > /dev/null 2>&1; then
    oqa_st_fail "driver: bun guard missed the appeared bun/ directory"; driver_fails=$((driver_fails + 1))
  else
    oqa_st_pass "driver: bun guard FAILs when bun/ appeared during the run"
  fi
  REPO_BUN_DIR_BEFORE="1"
  if oqa_pl_bun_junk_check; then
    oqa_st_pass "driver: pre-existing bun/ does not trip the guard"
  else
    bad "driver: bun guard tripped on a pre-existing bun/"; driver_fails=$((driver_fails + 1))
  fi
  REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"

  # 6f. plugin reload for the stats lines: the line appears after step 1
  # (config rewrite), after step 2 (bundle touch), and never (FAIL). The
  # append jobs are waited on by PID: a bare wait would also wait for the
  # still-running stub server of the last runner case.
  local rdir="$TMP/dtreload" stats_line fails_before marker app_pid
  mkdir -p "$rdir"
  EV_LIVE="$rdir"
  stats_line='[opencode-v2] event stats {"directory":"/probe","eventsSeen":1,"translated":1,"fetchWorthy":1,"coalesceBatches":0,"contextFetches":1,"contextFetchFailures":0}'
  OQA_PL_PLUGIN_BUNDLE="$rdir/fake-dist.js"
  OQA_PL_RELOAD_POLL_SECS=2
  touch -t 202001010000 "$rdir/fake-dist.js"

  printf 'server listening\n' > "$rdir/serve.out"
  rm -f "$rdir/cfg.json" "$rdir/stats-lines.txt"
  ( sleep 0.5; printf '%s\n' "$stats_line" >> "$rdir/serve.out" ) &
  app_pid=$!
  if oqa_pl_reload_for_stats "$rdir/serve.out" "$rdir/cfg.json" '{"model":"openai/gpt-fake"}'; then
    if grep -q 'reload_probe' "$rdir/cfg.json" && grep -qF 'event stats' "$rdir/stats-lines.txt"; then
      oqa_st_pass "driver: reload trigger finds the stats line after the config rewrite (step 1)"
    else
      bad "driver: reload step 1 passed but the probe config or the stats copy is wrong"
      driver_fails=$((driver_fails + 1))
    fi
  else
    bad "driver: reload trigger failed although the line appeared after step 1"
    driver_fails=$((driver_fails + 1))
  fi
  wait "$app_pid" 2>/dev/null || true

  printf 'server listening\n' > "$rdir/serve.out"
  marker="$rdir/step2.marker"
  touch "$marker"
  ( sleep 3; printf '%s\n' "$stats_line" >> "$rdir/serve.out" ) &
  app_pid=$!
  if oqa_pl_reload_for_stats "$rdir/serve.out" "$rdir/cfg.json" '{"model":"openai/gpt-fake"}' \
     && [ "$rdir/fake-dist.js" -nt "$marker" ]; then
    oqa_st_pass "driver: reload trigger falls back to the bundle touch and finds the line (step 2)"
  else
    bad "driver: reload step 2 (bundle touch) failed"
    driver_fails=$((driver_fails + 1))
  fi
  wait "$app_pid" 2>/dev/null || true

  printf 'server listening\n' > "$rdir/serve.out"
  fails_before=$FAILS
  if oqa_pl_reload_for_stats "$rdir/serve.out" "$rdir/cfg.json" '{"model":"openai/gpt-fake"}'; then
    bad "driver: reload trigger passed although no stats line ever appeared"
    driver_fails=$((driver_fails + 1))
  else
    if [ $((FAILS - fails_before)) -eq 1 ] && [ ! -s "$rdir/stats-lines.txt" ]; then
      oqa_st_pass "driver: reload trigger FAILs truthfully when no stats line ever appears"
    else
      bad "driver: reload never-case did not report the failure truthfully"
      driver_fails=$((driver_fails + 1))
    fi
  fi
  unset OQA_PL_PLUGIN_BUNDLE OQA_PL_RELOAD_POLL_SECS

  FAILS=$((self_fails + driver_fails))
}

main
exit $?
