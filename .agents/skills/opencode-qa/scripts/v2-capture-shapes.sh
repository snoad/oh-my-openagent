#!/usr/bin/env bash
# v2-capture-shapes.sh - capture OpenCode 2.4.1 host shapes as committed fixtures.
#
# Drives the pinned OC2 binary inside an isolated v2 sandbox (lib/v2-sandbox.sh)
# against the scenario fake model (lib/v2-fake-model.mjs) and writes, to
# V2/parity/fixtures/host-2.4.1/ by default:
#   events-a.jsonl, events-b.jsonl                (GET /api/event, filtered to the run session)
#   events-fail-<class>.jsonl                     (one per failure class, incl. 500)
#   context-a.json, context-b.json                (GET /api/session/<sid>/context)
#   tools.json                                    (session context hook tools map; no /api/tool exists)
#   agents.json, mcp.json, commands.json          (GET /api/agent|/api/mcp|/api/command, data sorted)
#   paths.txt                                     (OC2 debug paths)
#   hook-context-b.json                           (probe plugin hook payloads of scenario B)
#
# The sandbox loads ONLY the throwaway probe plugin (generated into the
# sandbox, never into the repo): it dumps the prompt/context/compaction/
# experimental.idle hook payloads, upserts a probe agent through
# ctx.agent.transform + editor.update on a missing id (L-03 evidence), and
# ships a TUI part claiming one slot (driven once under tmux at the end).
#
# Host facts this driver relies on (observed live on 2.4.1, see evidence):
#   - the host speaks the OpenAI Responses API at <baseURL>/v1/responses
#   - /api/event is a GET SSE stream; session.status/session.idle are never
#     emitted by 2.4.1 (the terminal signal is session.execution.*)
#   - OC2 run --server <url> --format json drives a run through this server
#
# Usage:
#   v2-capture-shapes.sh [--fixtures-dir DIR] [--evidence-dir DIR]
#                        [--self-test] [--help]
#
# Env:
#   OQA_V2_FIXTURES_DIR   fixture output dir (default the repo fixtures path)
#   OQA_V2_EVIDENCE_DIR   evidence copies (default none)
#
# Exit codes:
#   0  all fixtures captured and validated
#   1  capture or validation failure
#   2  usage error

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/v2-sandbox.sh"

# ---- defaults ----------------------------------------------------------------
FIXTURES_DIR=""
EVIDENCE_DIR=""
SELF_TEST=0
FAKE_PID=""
EVT_PID=""
FAKE_PORT=""
WORK_DIR=""
PROJ_DIR=""
RUN_COUNT=0
FAILS=0

OQA_V2CS_FIXTURES_DEFAULT="$SCRIPT_DIR/../../../../packages/omo-opencode/src/opencode-v2/parity/fixtures/host-2.4.1"

oqa_v2cs_log()  { printf '[v2-capture] %s\n' "$*" >&2; }
oqa_v2cs_pass() { printf 'PASS: %s\n' "$*"; }
oqa_v2cs_fail() { printf 'FAIL: %s\n' "$*" >&2; FAILS=$((FAILS + 1)); return 1; }

# ---- argument parsing --------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --fixtures-dir)
      [ $# -ge 2 ] || { printf 'error: --fixtures-dir requires a path\n' >&2; exit 2; }
      FIXTURES_DIR="$2"; shift 2 ;;
    --evidence-dir)
      [ $# -ge 2 ] || { printf 'error: --evidence-dir requires a path\n' >&2; exit 2; }
      EVIDENCE_DIR="$2"; shift 2 ;;
    --self-test) SELF_TEST=1; shift ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[ -n "$FIXTURES_DIR" ] || FIXTURES_DIR="${OQA_V2_FIXTURES_DIR:-$OQA_V2CS_FIXTURES_DEFAULT}"
mkdir -p "$FIXTURES_DIR" || { printf 'error: cannot create fixtures dir %s\n' "$FIXTURES_DIR" >&2; exit 2; }
FIXTURES_DIR="$(cd "$FIXTURES_DIR" && pwd)"

# ---- cleanup -----------------------------------------------------------------
oqa_v2cs_stop_evt() {
  if [ -n "$EVT_PID" ]; then
    kill "$EVT_PID" 2>/dev/null || true
    EVT_PID=""
  fi
}

oqa_v2cs_stop_fake() {
  if [ -n "$FAKE_PID" ]; then
    kill "$FAKE_PID" 2>/dev/null || true
    sleep 0.3
    kill -0 "$FAKE_PID" 2>/dev/null && kill -9 "$FAKE_PID" 2>/dev/null || true
    FAKE_PID=""
  fi
}

trap 'oqa_v2cs_stop_evt; oqa_v2cs_stop_fake; oqa_v2_teardown; [ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR"' EXIT

# ---- fake model control ------------------------------------------------------

# Start the fake model in <mode> with <scenario> (optional) on $FAKE_PORT.
# NEVER call this inside $( ): the background process would hold the pipe.
oqa_v2cs_start_fake() {
  local mode="$1" scenario="${2:-}" out="$3" i
  oqa_v2cs_stop_fake
  for i in $(seq 1 10); do
    curl -sf -m 2 "http://127.0.0.1:$FAKE_PORT/health" >/dev/null 2>&1 || break
    sleep 0.3
  done
  OQA_V2_FAKE_PORT="$FAKE_PORT" OQA_V2_FAKE_MODE="$mode" \
    OQA_V2_FAKE_SCENARIO="$scenario" OQA_V2_FAKE_OUT="$out" \
    node "$SCRIPT_DIR/lib/v2-fake-model.mjs" > "$WORK_DIR/fake.out" 2>&1 &
  FAKE_PID=$!
  for i in $(seq 1 40); do
    if grep -q "v2-fake-model listening on " "$WORK_DIR/fake.out" 2>/dev/null; then break; fi
    if ! kill -0 "$FAKE_PID" 2>/dev/null; then
      oqa_v2cs_log "fake model died at startup (mode=$mode):"
      cat "$WORK_DIR/fake.out" >&2 2>/dev/null || true
      return 1
    fi
    sleep 0.25
  done
  for i in $(seq 1 40); do
    curl -sf -m 2 "http://127.0.0.1:$FAKE_PORT/health" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  oqa_v2cs_log "fake model /health never answered (mode=$mode)"
  return 1
}

# ---- normalization helper (node, generated at runtime) ----------------------

# Writes the normalize helper into the work dir. Kinds:
#   sse       <in> <out> sse [sid]          strip SSE framing, filter to sid, trim
#   json      <in> <out> json               parse, trim, pretty
#   toplist   <in> <out> toplist            {location,data} -> {data sorted}
#   hookdump  <in> <out> hookdump [sid]     hook lines -> {hook: [payloads]}
#   tools     <in> <out> tools [sid]        hook lines -> {tools:[{id,parameters}]}
oqa_v2cs_write_normalize() {
  cat > "$WORK_DIR/normalize.mjs" <<'NODE'
import fs from "node:fs"

const [inPath, outPath, kind, sid] = process.argv.slice(2)
const CAP = 4096

function trim(value) {
  if (typeof value === "string") {
    return value.length > CAP ? value.slice(0, CAP) + ` [truncated ${value.length} chars]` : value
  }
  if (Array.isArray(value)) return value.map(trim)
  if (value !== null && typeof value === "object") {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = trim(value[key])
    return out
  }
  return value
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === "object") {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
    return out
  }
  return value
}

function readLines(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0)
}

if (kind === "sse") {
  const out = []
  for (const line of fs.readFileSync(inPath, "utf8").split("\n")) {
    if (!line.startsWith("data: ")) continue
    const text = line.slice(6)
    if (text.trim() === "" || text === "[DONE]") continue
    let event
    try { event = JSON.parse(text) } catch { continue }
    if (sid && (!event.data || event.data.sessionID !== sid)) continue
    out.push(JSON.stringify(trim(event)))
  }
  fs.writeFileSync(outPath, out.length ? out.join("\n") + "\n" : "")
} else if (kind === "json") {
  const parsed = JSON.parse(fs.readFileSync(inPath, "utf8"))
  fs.writeFileSync(outPath, JSON.stringify(trim(parsed), null, 2) + "\n")
} else if (kind === "toplist") {
  const parsed = JSON.parse(fs.readFileSync(inPath, "utf8"))
  const data = Array.isArray(parsed.data) ? parsed.data : parsed
  if (Array.isArray(data)) {
    data.sort((a, b) => {
      const ka = String(a.id ?? a.name ?? "")
      const kb = String(b.id ?? b.name ?? "")
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
    fs.writeFileSync(outPath, JSON.stringify({ data: data.map(trim) }, null, 2) + "\n")
  } else {
    fs.writeFileSync(outPath, JSON.stringify(trim(parsed), null, 2) + "\n")
  }
} else if (kind === "hookdump" || kind === "tools") {
  const collected = {}
  const tools = []
  for (const line of readLines(inPath)) {
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record.hook === undefined) continue
    const payloadSession = record.payload && record.payload.sessionID
    if (sid && payloadSession !== sid) continue
    if (kind === "hookdump") {
      if (!collected[record.hook]) collected[record.hook] = []
      collected[record.hook].push(trim(record.payload))
    } else if (record.hook === "context" && tools.length === 0) {
      const map = record.payload && record.payload.tools
      if (map && typeof map === "object") {
        for (const id of Object.keys(map).sort()) {
          tools.push({ id, parameters: trim(map[id].input) })
        }
      }
    }
  }
  if (kind === "hookdump") {
    fs.writeFileSync(outPath, JSON.stringify(sortKeys(collected), null, 2) + "\n")
  } else {
    fs.writeFileSync(outPath, JSON.stringify({ tools }, null, 2) + "\n")
  }
} else {
  process.stderr.write(`normalize: unknown kind ${kind}\n`)
  process.exit(2)
}
NODE
  node --check "$WORK_DIR/normalize.mjs" || return 1
}

# ---- probe plugin (generated into the sandbox, never the repo) ---------------

oqa_v2cs_write_probe_plugin() {
  local dir="$1"
  mkdir -p "$dir"
  printf '%s\n' '{"name":"oqa-v2-probe","version":"1.0.0","type":"module","exports":{".":"./index.js","./server":"./index.js","./tui":"./tui.js"}}' > "$dir/package.json"
  cat > "$dir/index.js" <<'NODE'
import { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import path from "node:path"

const dumpPath = process.env.OQA_PROBE_HOOK_DUMP ?? ""
const toolsPath = process.env.OQA_PROBE_TOOLS_DUMP ?? ""

function serialize(value) {
  const seen = new WeakSet()
  return JSON.parse(
    JSON.stringify(value, (key, item) => {
      if (typeof item === "function") return "[function]"
      if (typeof item === "bigint") return String(item)
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[circular]"
        seen.add(item)
      }
      return item
    }),
  )
}

async function dump(hook, payload) {
  if (!dumpPath) return
  try {
    fs.appendFileSync(dumpPath, JSON.stringify({ hook, payload: serialize(payload) }) + "\n")
  } catch (error) {
    process.stderr.write(`oqa-v2-probe: dump failed: ${error}\n`)
  }
}

export default Plugin.define({
  id: "oqa-v2-probe",
  setup: async (ctx) => {
    await ctx.session.hook("prompt", (payload) => dump("prompt", payload))
    await ctx.session.hook("context", (payload) => dump("context", payload))
    await ctx.session.hook("compaction", (payload) => dump("compaction", payload))
    await ctx.session.hook("experimental.idle", (payload) => dump("experimental.idle", payload))
    await ctx.agent.transform((editor) => {
      editor.update("oqa-probe-agent", (agent) => {
        agent.name = "OQA Probe Agent"
        agent.description = "upserted by oqa-v2-probe"
        agent.mode = "all"
      })
    })
  },
})
NODE
  cat > "$dir/tui.js" <<'NODE'
import { Plugin } from "@opencode/plugin/tui"
import fs from "node:fs"

const markerPath = process.env.OQA_PROBE_TUI_MARKERS ?? ""

function mark(entry) {
  if (!markerPath) return
  try {
    fs.appendFileSync(markerPath, JSON.stringify({ at: Date.now(), ...entry }) + "\n")
  } catch (error) {
    process.stderr.write(`oqa-v2-probe: tui marker failed: ${error}\n`)
  }
}

export default Plugin.define({
  id: "oqa-v2-probe",
  setup: async (ctx) => {
    mark({ phase: "setup", app: ctx.app ? ctx.app.version : null })
    let jsx = null
    try {
      const runtime = await import("solid-js/jsx-runtime")
      if (typeof runtime.jsx === "function") {
        jsx = runtime.jsx
        mark({ phase: "jsx-runtime-available" })
      } else {
        mark({ phase: "jsx-runtime-no-jsx", keys: Object.keys(runtime).slice(0, 12) })
      }
    } catch (error) {
      mark({ phase: "jsx-runtime-unavailable", error: String(error) })
    }
    try {
      const solid = await import("solid-js")
      mark({ phase: "solid-js-available", hasJSX: typeof solid.jsx })
    } catch (error) {
      mark({ phase: "solid-js-unavailable", error: String(error) })
    }
    try {
      const opentui = await import("@opentui/solid")
      mark({ phase: "opentui-solid-available", hasJSX: typeof opentui.jsx, keys: Object.keys(opentui).slice(0, 12) })
      if (typeof opentui.jsx === "function" && !jsx) {
        jsx = opentui.jsx
      }
    } catch (error) {
      mark({ phase: "opentui-solid-unavailable", error: String(error) })
    }
    try {
      ctx.ui.slot({
        append: "home.footer.status",
        render: () => {
          mark({ phase: "render" })
          if (jsx) {
            try {
              return jsx("text", { children: "oqa-v2-probe" })
            } catch (error) {
              mark({ phase: "jsx-error", error: String(error) })
            }
          }
          return "oqa-v2-probe"
        },
      })
      mark({ phase: "slot-claimed", path: "home.footer.status" })
    } catch (error) {
      mark({ phase: "slot-claim-error", error: String(error) })
    }
  },
})
NODE
  node --check "$dir/index.js" && node --check "$dir/tui.js"
}

# ---- one capture run ---------------------------------------------------------

# Runs OC2 run against the live server. Uses globals:
#   OQA_V2_SERVER_URL / OQA_V2_SERVER_PASS / OC2 / PROJ_DIR / WORK_DIR
# Args: <label> <prompt> <raw-out-prefix> ; sets OQA_V2CS_SID + OQA_V2CS_RC
oqa_v2cs_run_once() {
  local label="$1" prompt="$2" prefix="$3"
  oqa_v2cs_stop_evt
  RUN_COUNT=$((RUN_COUNT + 1))
  rm -f "$WORK_DIR/$prefix.raw" "$WORK_DIR/$prefix.run.json" "$WORK_DIR/$prefix.run.err"
  ( curl -s -m 300 -N -u "opencode:$OQA_V2_SERVER_PASS" \
      "$OQA_V2_SERVER_URL/api/event" > "$WORK_DIR/$prefix.raw" 2>/dev/null ) &
  EVT_PID=$!
  ( cd "$PROJ_DIR" && OPENCODE_PASSWORD="$OQA_V2_SERVER_PASS" timeout 240 "$OC2" run "$prompt" \
      --title "$label" --format json --server "$OQA_V2_SERVER_URL" ) \
    > "$WORK_DIR/$prefix.run.json" 2> "$WORK_DIR/$prefix.run.err"
  OQA_V2CS_RC=$?
  sleep 2
  oqa_v2cs_stop_evt
  OQA_V2CS_SID="$(jq -r 'select(.sessionID != null) | .sessionID' "$WORK_DIR/$prefix.run.json" 2>/dev/null | head -1)"
  if [ -z "${OQA_V2CS_SID:-}" ]; then
    OQA_V2CS_SID="$(grep '^data: ' "$WORK_DIR/$prefix.raw" 2>/dev/null | sed 's/^data: //' \
      | jq -r 'select(.type == "session.created") | .data.sessionID' 2>/dev/null | tail -1)"
  fi
  oqa_v2cs_log "run '$label' rc=$OQA_V2CS_RC sid=${OQA_V2CS_SID:-none}"
}

# ---- fixture validation ------------------------------------------------------

oqa_v2cs_check_fixture() {
  local file="$1" kind="$2" size
  [ -f "$file" ] || { oqa_v2cs_fail "fixture missing: $file"; return 1; }
  size="$(wc -c < "$file" | tr -d ' ')"
  if [ "$size" -gt 204800 ]; then
    oqa_v2cs_fail "fixture over 200 KB: $file ($size bytes)"
    return 1
  fi
  if [ "$kind" = "json" ]; then
    jq -e . "$file" >/dev/null 2>&1 || { oqa_v2cs_fail "fixture is not valid JSON: $file"; return 1; }
  elif [ "$kind" = "jsonl" ]; then
    [ "$size" -gt 0 ] || { oqa_v2cs_fail "fixture is empty: $file"; return 1; }
    while IFS= read -r line; do
      printf '%s' "$line" | jq -e . >/dev/null 2>&1 || { oqa_v2cs_fail "fixture line is not valid JSON: $file"; return 1; }
    done < "$file"
  fi
  oqa_v2cs_pass "fixture ok: $(basename "$file") ($size bytes, $kind)"
}

# ---- self-test (no host, no sandbox) -----------------------------------------

oqa_v2cs_self_test() {
  local fails=0 tmp out i
  oqa_require node curl jq || return 1
  tmp="$(mktemp -d -t oqa-v2cs-st.XXXXXX)"
  WORK_DIR="$tmp"
  oqa_v2cs_write_normalize || { oqa_v2cs_log "FAIL: normalize helper failed syntax check"; return 1; }

  printf '%s\n' '{"steps":[{"text":"A_OK"},{"tool_call":{"name":"read","arguments":{"path":"/tmp/x"}}},{"text":"B_OK"}]}' > "$tmp/scen.json"

  FAKE_PORT="$(oqa_v2_find_free_port)"
  mkdir -p "$tmp/req"
  oqa_v2cs_start_fake scenario "$tmp/scen.json" "$tmp/req" || { oqa_v2cs_log "FAIL: fake model did not start"; return 1; }

  local resp
  resp="$(curl -sf -m 5 -X POST "http://127.0.0.1:$FAKE_PORT/v1/responses" \
    -H 'content-type: application/json' \
    -d '{"model":"gpt-fake","stream":true,"tools":[{"type":"function","name":"read"}]}' 2>/dev/null)"
  if printf '%s' "$resp" | grep -q '"response.created"' && printf '%s' "$resp" | grep -q 'A_OK'; then
    oqa_v2cs_pass "scenario text step served"
  else
    oqa_v2cs_log "FAIL: scenario text step missing"; fails=$((fails+1))
  fi
  resp="$(curl -sf -m 5 -X POST "http://127.0.0.1:$FAKE_PORT/v1/responses" \
    -H 'content-type: application/json' \
    -d '{"model":"gpt-fake","stream":true,"tools":[{"type":"function","name":"read"}]}' 2>/dev/null)"
  if printf '%s' "$resp" | grep -q '"function_call"' && printf '%s' "$resp" | grep -q '"name":"read"'; then
    oqa_v2cs_pass "scenario tool-call step served"
  else
    oqa_v2cs_log "FAIL: tool-call step missing"; fails=$((fails+1))
  fi
  resp="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$FAKE_PORT/v1/responses" \
    -H 'content-type: application/json' -d '{"model":"gpt-fake"}' 2>/dev/null)"
  if [ "$(cat "$tmp/req/requests.jsonl" | wc -l)" -ge 3 ] && jq -e . "$tmp/req/requests.jsonl" >/dev/null 2>&1; then
    oqa_v2cs_pass "request bodies recorded to requests.jsonl"
  else
    oqa_v2cs_log "FAIL: requests.jsonl not recorded"; fails=$((fails+1))
  fi

  oqa_v2cs_stop_fake

  for mode in fail fail-401 fail-429 fail-404-model fail-400-overflow; do
    oqa_v2cs_start_fake "$mode" "" "$tmp/req-$mode" || { oqa_v2cs_log "FAIL: fake $mode did not start"; fails=$((fails+1)); continue; }
    local code
    code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$FAKE_PORT/v1/responses" \
      -H 'content-type: application/json' -d '{"model":"gpt-fake"}' 2>/dev/null)"
    local want
    case "$mode" in
      fail) want=500 ;;
      fail-401) want=401 ;;
      fail-429) want=429 ;;
      fail-404-model) want=404 ;;
      fail-400-overflow) want=400 ;;
    esac
    if [ "$code" = "$want" ]; then
      oqa_v2cs_pass "fail mode $mode answers $want"
    else
      oqa_v2cs_log "FAIL: fail mode $mode answered $code (want $want)"; fails=$((fails+1))
    fi
    oqa_v2cs_stop_fake
  done

  # trim helper check
  printf '%s\n' '{"a":"'"$(printf 'x%.0s' $(seq 1 5000))"'","b":"short"}' > "$tmp/trim.json"
  node "$tmp/normalize.mjs" "$tmp/trim.json" "$tmp/trim.out.json" json
  if grep -q '\[truncated 5000 chars\]' "$tmp/trim.out.json" && jq -r '.b' "$tmp/trim.out.json" | grep -q short; then
    oqa_v2cs_pass "4 KB trim marker applied"
  else
    oqa_v2cs_log "FAIL: trim marker missing"; fails=$((fails+1))
  fi

  # sse parse check
  printf 'data: {"type":"a","data":{"sessionID":"s1"}}\n\n: heartbeat\ndata: {"type":"b","data":{}}\n' > "$tmp/sse.raw"
  node "$tmp/normalize.mjs" "$tmp/sse.raw" "$tmp/sse.out.jsonl" sse s1
  if [ "$(wc -l < "$tmp/sse.out.jsonl" | tr -d ' ')" = "1" ] && jq -r '.type' "$tmp/sse.out.jsonl" | grep -q '^a$'; then
    oqa_v2cs_pass "SSE parse + session filter works"
  else
    oqa_v2cs_log "FAIL: SSE parse broken"; fails=$((fails+1))
  fi

  oqa_v2cs_stop_fake
  rm -rf "$tmp"
  if [ "$fails" -eq 0 ]; then
    oqa_v2cs_pass "v2-capture-shapes self-test"
    return 0
  fi
  oqa_v2cs_log "self-test had $fails failure(s)"
  return 1
}

# ---- main capture -------------------------------------------------------------

oqa_v2cs_capture_event_stream() {
  # Writes evidence copies of the raw event stream when EVIDENCE_DIR is set.
  if [ -n "$EVIDENCE_DIR" ]; then
    mkdir -p "$EVIDENCE_DIR"
    cp "$WORK_DIR/$1.raw" "$EVIDENCE_DIR/$1-events-raw.sse" 2>/dev/null || true
    cp "$WORK_DIR/$1.run.json" "$EVIDENCE_DIR/$1-run.json" 2>/dev/null || true
  fi
}

oqa_v2cs_evidence() {
  if [ -n "$EVIDENCE_DIR" ]; then
    mkdir -p "$EVIDENCE_DIR"
    cat > "$EVIDENCE_DIR/$1"
  fi
}

oqa_v2cs_main() {
  oqa_require node curl jq git tmux || return 1

  # 1. work dir + fake model port
  WORK_DIR="$(mktemp -d -t oqa-v2-capture.XXXXXX)"
  oqa_v2cs_log "work dir: $WORK_DIR"
  oqa_v2cs_log "fixtures dir: $FIXTURES_DIR"
  FAKE_PORT="$(oqa_v2_find_free_port)"
  oqa_v2cs_write_normalize || { oqa_v2cs_log "FAIL: normalize helper failed"; return 1; }

  # 2. sandbox + probe plugin + provider config
  oqa_v2_mk_sandbox || return 1
  local probe_dir="$OQA_V2_SANDBOX/probe-plugin"
  oqa_v2cs_write_probe_plugin "$probe_dir" || { oqa_v2cs_log "FAIL: probe plugin failed syntax check"; return 1; }
  mkdir -p "$OQA_V2_SANDBOX/probe-out"
  export OQA_PROBE_HOOK_DUMP="$OQA_V2_SANDBOX/probe-out/hook-dump.jsonl"
  export OQA_PROBE_TOOLS_DUMP="$OQA_V2_SANDBOX/probe-out/tools-registry.json"
  export OQA_PROBE_TUI_MARKERS="$OQA_V2_SANDBOX/probe-out/tui-markers.jsonl"

  local cfg_dir
  cfg_dir="$(oqa_v2_config_path)" || return 1
  mkdir -p "$cfg_dir"
  # Provider schema settled live on 2.4.1 (OC2 debug config accepts the V1-style
  # shape; tool_call maps to capabilities.tools). Recorded in the evidence.
  cat > "$cfg_dir/opencode.json" <<JSON
{
  "model": "openai/gpt-fake",
  "plugin": ["$probe_dir"],
  "provider": {
    "openai": {
      "options": {
        "apiKey": "fake-key",
        "baseURL": "http://127.0.0.1:$FAKE_PORT/v1"
      },
      "models": {
        "gpt-fake": {
          "tool_call": true,
          "limit": { "context": 200000, "output": 8192 }
        }
      }
    }
  }
}
JSON

  # 3. temp git project for the runs (the read tool target lives inside it)
  PROJ_DIR="$WORK_DIR/proj"
  mkdir -p "$PROJ_DIR"
  git -C "$PROJ_DIR" init -q
  git -C "$PROJ_DIR" -c user.email=oqa@local -c user.name=oqa commit -q --allow-empty -m init
  printf 'hello v2 capture\n' > "$PROJ_DIR/capture-b.txt"

  # 4. scenarios
  printf '%s\n' '{"steps":[{"text":"A_FINAL: plain text answer from the v2 fake model"}]}' > "$WORK_DIR/scenario-a.json"
  printf '%s\n' "{\"steps\":[{\"tool_call\":{\"name\":\"read\",\"arguments\":{\"path\":\"$PROJ_DIR/capture-b.txt\"}}},{\"text\":\"B_FINAL: the file says hello v2 capture\"}]}" > "$WORK_DIR/scenario-b.json"

  # 5. serve + plugin
  oqa_v2_serve_start || return 1
  oqa_v2_wait_ready 30 || { oqa_v2cs_log "server never became ready"; return 1; }
  oqa_v2cs_log "server ready: $OQA_V2_SERVER_URL"
  if ! oqa_v2_wait_plugin oqa-v2-probe 60; then
    oqa_v2cs_fail "probe plugin oqa-v2-probe never appeared in GET /api/plugin"
    return 1
  fi
  oqa_v2cs_pass "probe plugin loaded (features $(oqa_v2_api GET /api/plugin \
    | jq -c '.data[] | select(.id == "oqa-v2-probe") | .features' 2>/dev/null))"

  # ---- scenario A: plain text answer ----
  mkdir -p "$WORK_DIR/requests-a"
  oqa_v2cs_start_fake scenario "$WORK_DIR/scenario-a.json" "$WORK_DIR/requests-a" || return 1
  oqa_v2cs_run_once "v2 capture a" "Reply with exactly: A_FINAL" a
  oqa_v2cs_capture_event_stream a
  if [ "$OQA_V2CS_RC" -ne 0 ] || [ -z "$OQA_V2CS_SID" ]; then
    oqa_v2cs_fail "scenario A run failed (rc=$OQA_V2CS_RC sid=${OQA_V2CS_SID:-none})"
  fi
  node "$WORK_DIR/normalize.mjs" "$WORK_DIR/a.raw" "$FIXTURES_DIR/events-a.jsonl" sse "$OQA_V2CS_SID"
  oqa_v2_api GET "/api/session/$OQA_V2CS_SID/context" > "$WORK_DIR/context-a.raw"
  node "$WORK_DIR/normalize.mjs" "$WORK_DIR/context-a.raw" "$FIXTURES_DIR/context-a.json" json

  # ---- scenario B: one read tool call, then a final text ----
  mkdir -p "$WORK_DIR/requests-b"
  oqa_v2cs_start_fake scenario "$WORK_DIR/scenario-b.json" "$WORK_DIR/requests-b" || return 1
  oqa_v2cs_run_once "v2 capture b" "Read capture-b.txt and reply with its exact content" b
  oqa_v2cs_capture_event_stream b
  local sid_b="$OQA_V2CS_SID"
  if [ "$OQA_V2CS_RC" -ne 0 ] || [ -z "$sid_b" ]; then
    oqa_v2cs_fail "scenario B run failed (rc=$OQA_V2CS_RC sid=${sid_b:-none})"
  fi
  node "$WORK_DIR/normalize.mjs" "$WORK_DIR/b.raw" "$FIXTURES_DIR/events-b.jsonl" sse "$sid_b"
  oqa_v2_api GET "/api/session/$sid_b/context" > "$WORK_DIR/context-b.raw"
  node "$WORK_DIR/normalize.mjs" "$WORK_DIR/context-b.raw" "$FIXTURES_DIR/context-b.json" json
  node "$WORK_DIR/normalize.mjs" "$OQA_PROBE_HOOK_DUMP" "$FIXTURES_DIR/hook-context-b.json" hookdump "$sid_b"
  # The compaction hook is registered but never fires in scenario B (the context
  # stays small): pin an explicit empty array so the fixture documents the hook
  # set the probe registered, not just the ones that fired.
  jq 'if has("compaction") then . else . + {compaction: []} end' \
    "$FIXTURES_DIR/hook-context-b.json" > "$WORK_DIR/hook-context-b.merged.json" \
    && mv "$WORK_DIR/hook-context-b.merged.json" "$FIXTURES_DIR/hook-context-b.json"

  # ---- one-time captures ----
  # tools.json: no GET /api/tool exists on 2.4.1; the session context hook's
  # tools map (name -> {description, input: JsonSchema}) is the registry the
  # host actually sends to the model. Settled alternative, recorded in evidence.
  node "$WORK_DIR/normalize.mjs" "$OQA_PROBE_HOOK_DUMP" "$FIXTURES_DIR/tools.json" tools "$sid_b"
  oqa_v2_api GET /api/agent > "$WORK_DIR/agents.raw"
  node "$WORK_DIR/normalize.mjs" "$WORK_DIR/agents.raw" "$FIXTURES_DIR/agents.json" toplist
  oqa_v2_api GET /api/mcp > "$WORK_DIR/mcp.raw"
  node "$WORK_DIR/normalize.mjs" "$WORK_DIR/mcp.raw" "$FIXTURES_DIR/mcp.json" toplist
  oqa_v2_api GET /api/command > "$WORK_DIR/commands.raw"
  node "$WORK_DIR/normalize.mjs" "$WORK_DIR/commands.raw" "$FIXTURES_DIR/commands.json" toplist
  "$OC2" debug paths > "$FIXTURES_DIR/paths.txt" 2>/dev/null

  # ---- upsert verdict (L-03 interim evidence) ----
  local agent_ids upsert_verdict
  agent_ids="$(jq -r '.data[].id' "$FIXTURES_DIR/agents.json" 2>/dev/null | sort | tr '\n' ' ')"
  if printf '%s' "$agent_ids" | grep -qw oqa-probe-agent; then
    upsert_verdict="PASS"
  else
    upsert_verdict="MISSING"
  fi
  oqa_v2cs_evidence upsert-probe.txt <<TXT
L-03 upsert probe verdict: $upsert_verdict
Method: probe plugin ctx.agent.transform + editor.update("oqa-probe-agent", ...) on a missing id,
assert GET /api/agent lists the agent id.
Agent ids after capture: $agent_ids
$([ "$upsert_verdict" = "PASS" ] && printf 'The update-on-missing-id path UPSERTS: the host created the agent.' || printf 'STOP-AND-REPORT: the probe agent is missing after upsert.')
TXT
  if [ "$upsert_verdict" != "PASS" ]; then
    oqa_v2cs_fail "upsert probe agent missing after ctx.agent.transform + editor.update (L-03)"
    return 1
  fi
  oqa_v2cs_pass "agent upsert on missing id creates oqa-probe-agent (L-03)"

  # ---- fail modes ----
  local mode class rc_summary=""
  local fail_modes=(fail fail-401 fail-429 fail-404-model fail-400-overflow fail-abort)
  local fail_classes=(500 401 429 404-model 400-overflow abort)
  local idx=0
  for mode in "${fail_modes[@]}"; do
    class="${fail_classes[$idx]}"
    idx=$((idx + 1))
    mkdir -p "$WORK_DIR/requests-$class"
    oqa_v2cs_start_fake "$mode" "" "$WORK_DIR/requests-$class" || return 1
    oqa_v2cs_run_once "v2 capture fail $class" "Reply with anything" "fail-$class"
    oqa_v2cs_capture_event_stream "fail-$class"
    rc_summary="$rc_summary
$class: rc=$OQA_V2CS_RC"
    if [ "$OQA_V2CS_RC" -eq 0 ]; then
      oqa_v2cs_fail "fail mode $class unexpectedly exited 0"
    fi
    node "$WORK_DIR/normalize.mjs" "$WORK_DIR/fail-$class.raw" "$FIXTURES_DIR/events-fail-$class.jsonl" sse "$OQA_V2CS_SID"
    local err_ok
    err_ok="$(jq -s '[.[] | select(.type == "session.execution.failed" or .type == "session.step.failed")] | length' \
      "$FIXTURES_DIR/events-fail-$class.jsonl" 2>/dev/null)"
    if [ "${err_ok:-0}" -ge 1 ]; then
      oqa_v2cs_pass "fail mode $class captured a terminal failure event"
    else
      oqa_v2cs_fail "fail mode $class produced no session.execution.failed/step.failed event"
    fi
  done
  oqa_v2cs_evidence fake-fail.txt <<TXT
Built-in fail-mode run (fake model answering 500):
  actual OC2 run exit code: 1 (the plan anticipated 4; observed live on 2.4.1)
  retry ladder observed: session.retry.scheduled events up to attempt 11 with exponential backoff
  terminal events: session.step.failed + session.execution.failed carrying
  {type: "provider.internal", message, status: 500, response: {body}}
Actual exit codes per class:$rc_summary
All events-fail-*.jsonl fixtures present:
$(ls -1 "$FIXTURES_DIR" | grep '^events-fail-' | sed 's/^/  /')
TXT

  # ---- TUI probe (one drive under tmux; a headless run never loads TUI parts) ----
  oqa_v2cs_probe_tui || oqa_v2cs_log "TUI probe recorded a non-accept verdict (see evidence)"

  # ---- fixture validation ----
  oqa_v2cs_check_fixture "$FIXTURES_DIR/events-a.jsonl" jsonl
  oqa_v2cs_check_fixture "$FIXTURES_DIR/events-b.jsonl" jsonl
  for class in 500 401 429 404-model 400-overflow abort; do
    oqa_v2cs_check_fixture "$FIXTURES_DIR/events-fail-$class.jsonl" jsonl
  done
  oqa_v2cs_check_fixture "$FIXTURES_DIR/context-a.json" json
  oqa_v2cs_check_fixture "$FIXTURES_DIR/context-b.json" json
  oqa_v2cs_check_fixture "$FIXTURES_DIR/tools.json" json
  oqa_v2cs_check_fixture "$FIXTURES_DIR/agents.json" json
  oqa_v2cs_check_fixture "$FIXTURES_DIR/mcp.json" json
  oqa_v2cs_check_fixture "$FIXTURES_DIR/commands.json" json
  oqa_v2cs_check_fixture "$FIXTURES_DIR/hook-context-b.json" json

  # events-b assertions
  local tool_called execution_done
  tool_called="$(jq -s '[.[] | select(.type == "session.tool.called")] | length' "$FIXTURES_DIR/events-b.jsonl" 2>/dev/null)"
  execution_done="$(jq -s '[.[] | select(.type == "session.execution.succeeded" or .type == "session.execution.failed")] | length' "$FIXTURES_DIR/events-b.jsonl" 2>/dev/null)"
  if [ "${tool_called:-0}" -ge 1 ]; then
    oqa_v2cs_pass "events-b.jsonl carries session.tool.called (${tool_called}x)"
  else
    oqa_v2cs_fail "events-b.jsonl has no session.tool.called event"
  fi
  if [ "${execution_done:-0}" -ge 1 ]; then
    oqa_v2cs_pass "events-b.jsonl ends with a terminal session.execution.* event"
  else
    oqa_v2cs_fail "events-b.jsonl has no terminal session.execution.* event"
  fi
  oqa_v2cs_evidence session-status-note.txt <<TXT
session.status / session.idle are never emitted by host 2.4.1 (verified live in run,
prompt-API, retry and abort flows; externally confirmed by anomalyco/opencode issues
#66018 and #55358, PR #55380 not in 2.4.1). The terminal completion signal is
session.execution.succeeded/failed/interrupted, and the plugin-side
experimental.idle session hook fires with {sessionID, background}. events-b.jsonl
therefore records session.execution.succeeded as the final event; no
session.status line exists to capture without fabricating one.
TXT

  # fail error object assertions
  local class err_fields
  for class in 500 401 429 404-model 400-overflow abort; do
    err_fields="$(jq -s '[.[] | select(.type == "session.execution.failed" or .type == "session.step.failed")
      | .data.error | select(.type != null and .message != null)] | length' \
      "$FIXTURES_DIR/events-fail-$class.jsonl" 2>/dev/null)"
    if [ "${err_fields:-0}" -ge 1 ]; then
      oqa_v2cs_pass "events-fail-$class.jsonl error objects carry type and message"
    else
      oqa_v2cs_fail "events-fail-$class.jsonl error object missing type/message"
    fi
  done

  # kebab-case naming guard (the V2 boundary guard scans every file)
  local bad_name
  bad_name="$(find "$FIXTURES_DIR" -maxdepth 1 -type f -printf '%f\n' | grep -Ev '^[a-z0-9][a-z0-9.-]*$' || true)"
  if [ -z "$bad_name" ]; then
    oqa_v2cs_pass "all fixture names are kebab-case"
  else
    oqa_v2cs_fail "non-kebab fixture names: $bad_name"
  fi

  oqa_v2cs_stop_evt
  oqa_v2cs_stop_fake

  if [ "$FAILS" -ne 0 ]; then
    oqa_v2cs_log "capture finished with $FAILS failure(s)"
    return 1
  fi

  jq -cn \
    --arg fixtures "$(ls -1 "$FIXTURES_DIR" | sort | tr '\n' ' ')" \
    --arg upsert "$upsert_verdict" \
    --arg tui "${OQA_V2CS_TUI_VERDICT:-not-run}" \
    '{fixtures: ($fixtures | split(" ") | map(select(length > 0))),
      upsertVerdict: $upsert, tuiVerdict: $tui}'
  oqa_v2cs_pass "v2-capture-shapes"
  return 0
}

oqa_v2cs_probe_tui() {
  local sess="oqa_v2_tui_${$}"
  local launcher="$OQA_V2_SANDBOX/tmp/tui-launcher.sh"
  cat > "$launcher" <<SCRIPT
#!/usr/bin/env bash
cd "$PROJ_DIR"
export HOME="$HOME"
export XDG_CONFIG_HOME="$XDG_CONFIG_HOME"
export XDG_DATA_HOME="$XDG_DATA_HOME"
export XDG_CACHE_HOME="$XDG_CACHE_HOME"
export XDG_STATE_HOME="$XDG_STATE_HOME"
export TMPDIR="$TMPDIR"
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_MODELS_FETCH=1
export OQA_PROBE_TUI_MARKERS="$OQA_PROBE_TUI_MARKERS"
exec "$OC2" --standalone
SCRIPT
  chmod +x "$launcher"
  rm -f "$OQA_PROBE_TUI_MARKERS"
  tmux new-session -d -s "$sess" -x 200 -y 50
  OQA_TMUX_SESSIONS+=("$sess")
  tmux send-keys -t "$sess" "bash $launcher" Enter

  local i cap="" markers=""
  for i in $(seq 1 60); do
    markers="$(cat "$OQA_PROBE_TUI_MARKERS" 2>/dev/null || true)"
    if printf '%s' "$markers" | grep -q '"phase":"setup"'; then break; fi
    cap="$(tmux capture-pane -t "$sess" -p 2>/dev/null || true)"
    if printf '%s' "$cap" | grep -qiE "error|failed to load plugin"; then break; fi
    sleep 0.5
  done
  sleep 2
  cap="$(tmux capture-pane -t "$sess" -p 2>/dev/null || true)"
  tmux kill-session -t "$sess" 2>/dev/null || true
  markers="$(cat "$OQA_PROBE_TUI_MARKERS" 2>/dev/null || true)"

  local verdict render_outcome
  if printf '%s' "$markers" | grep -q '"phase":"setup"' && printf '%s' "$markers" | grep -q '"phase":"slot-claimed"'; then
    verdict="ACCEPT"
  elif printf '%s' "$markers" | grep -q '"phase":"slot-claim-error"'; then
    verdict="REJECT"
  elif printf '%s' "$markers" | grep -q '"phase":"setup"'; then
    verdict="LOADED-NO-CLAIM"
  else
    verdict="NO-LOAD"
  fi
  render_outcome="not-rendered"
  if printf '%s' "$markers" | grep -q '"phase":"render"'; then
    if printf '%s' "$cap" | grep -q "crashed in slot"; then
      render_outcome="render-invoked-host-rejected-bare-text"
    elif printf '%s' "$markers" | grep -q '"phase":"jsx-error"'; then
      render_outcome="render-invoked-jsx-error"
    else
      render_outcome="rendered-without-slot-crash"
    fi
  fi
  OQA_V2CS_TUI_VERDICT="$verdict"
  oqa_v2cs_evidence tui-render-probe.txt <<TXT
TUI part probe verdict: $verdict (render outcome: $render_outcome)
Method: probe plugin tui.js entry (default export Plugin.define from @opencode/plugin/tui)
claims home.footer.status via ctx.ui.slot({append, render}); the host TUI was driven ONCE
under tmux (opencode --standalone inside the sandbox; a headless OC2 run never loads TUI parts).
The render also probes whether solid-js is importable from plugin TUI code and, when it is,
returns jsx("text", {children}) instead of a bare string.
Marker lines from the TUI process:
${markers:-<none>}
Render phase invoked: $(printf '%s' "$markers" | grep -q '"phase":"render"' && printf yes || printf no)
Pane capture (first 30 lines):
$(printf '%s' "$cap" | head -30)
Host log role=tui lines:
$(grep 'role=tui' "$(oqa_v2_log_path)/opencode.log" 2>/dev/null | tail -5 || true)
Interpretation:
  ACCEPT = the host TUI loaded the part and accepted the slot claim; the wave-5
  rendering approach is viable at the claim level. The render outcome refines it:
    rendered-without-slot-crash = a solid-js <text> element rendered cleanly.
    render-invoked-host-rejected-bare-text = the host renders the claim but
    rejects bare-text returns with "wrap it in <text>"; use JSX elements.
  REJECT/NO-LOAD = stop-and-report evidence against the wave-5 rendering approach (LIM-4).
TXT
  if [ "$verdict" = "ACCEPT" ]; then
    oqa_v2cs_pass "host TUI accepted the one-slot TUI part ($verdict, $render_outcome)"
    return 0
  fi
  oqa_v2cs_fail "host TUI did not accept the one-slot TUI part (verdict $verdict)"
  return 1
}

# ---- dispatch ----------------------------------------------------------------
if [ "$SELF_TEST" -eq 1 ]; then
  oqa_v2cs_self_test
  exit $?
fi

oqa_v2cs_main
exit $?
