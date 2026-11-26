#!/usr/bin/env node
// v2-fake-model.mjs - zero-dependency scripted fake model for OpenCode 2 QA.
//
// Serves the OpenAI wire protocol the OpenCode 2.4.1 host actually speaks:
// POST <base>/v1/responses (Responses API, SSE streaming) is the primary path,
// POST <base>/v1/chat/completions is also handled so the same fake works for
// chat-completions consumers. Every request body is appended verbatim to
// <out>/requests.jsonl (one request body per line) so later tasks can assert
// context-hook effects against the exact payloads the host sent.
//
// A scenario is a JSON file: { "steps": [ { "text": "..." } |
// { "tool_call": { "name": "...", "arguments": { ... } } } ] }. Steps are
// consumed in order by MAIN conversation requests only (a request whose body
// carries a non-empty tools array; auxiliary requests such as title or
// instruction generation come without tools and get a canned short text).
// After the steps run out the last step repeats, keeping re-runs total.
//
// Env:
//   OQA_V2_FAKE_PORT      port to bind (default 0 = random)
//   OQA_V2_FAKE_MODE      scenario | fail | fail-401 | fail-429 |
//                         fail-404-model | fail-400-overflow | fail-abort
//                         (default scenario)
//   OQA_V2_FAKE_SCENARIO  scenario JSON path (scenario mode)
//   OQA_V2_FAKE_OUT       output dir for requests.jsonl (default
//                         <tmpdir>/oqa-v2-fake)
//
// Prints "v2-fake-model listening on <port>" on stdout once bound; the shell
// driver parses the port from that line. GET /health answers 200 "ok".

import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const port = Number(process.env.OQA_V2_FAKE_PORT ?? 0)
const mode = process.env.OQA_V2_FAKE_MODE ?? "scenario"
const scenarioPath = process.env.OQA_V2_FAKE_SCENARIO ?? ""
const outDir = process.env.OQA_V2_FAKE_OUT ?? path.join(os.tmpdir(), "oqa-v2-fake")
const requestsFile = path.join(outDir, "requests.jsonl")

const FAIL_MODES = new Set(["fail", "fail-401", "fail-429", "fail-404-model", "fail-400-overflow", "fail-abort"])
if (mode !== "scenario" && !FAIL_MODES.has(mode)) {
  process.stderr.write(`v2-fake-model: unknown OQA_V2_FAKE_MODE '${mode}'\n`)
  process.exit(2)
}

let steps = []
if (mode === "scenario") {
  if (!scenarioPath) {
    process.stderr.write("v2-fake-model: OQA_V2_FAKE_SCENARIO is required in scenario mode\n")
    process.exit(2)
  }
  const parsed = JSON.parse(fs.readFileSync(scenarioPath, "utf8"))
  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    process.stderr.write("v2-fake-model: scenario file must carry a non-empty steps array\n")
    process.exit(2)
  }
  steps = parsed.steps
}

let mainRequestCount = 0

function appendRequest(bodyText) {
  try {
    fs.mkdirSync(outDir, { recursive: true })
    fs.appendFileSync(requestsFile, bodyText.replace(/\n+$/, "") + "\n")
  } catch (error) {
    process.stderr.write(`v2-fake-model: failed to record request: ${error}\n`)
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function nextStep() {
  if (steps.length === 0) return { text: "oqa-fake-aux" }
  const step = steps[Math.min(mainRequestCount, steps.length - 1)]
  mainRequestCount += 1
  return step
}

function usage() {
  return {
    input_tokens: 10,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  }
}

// ---- OpenAI Responses API (the protocol OpenCode 2.4.1 uses) ----

function sendResponsesText(res, model, text) {
  const id = `resp_${mainRequestCount}`
  const item = `msg_${mainRequestCount}`
  const events = [
    { type: "response.created", response: { id, created_at: Math.floor(Date.now() / 1000), model } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: item } },
    { type: "response.output_text.delta", item_id: item, output_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: item } },
    { type: "response.completed", response: { usage: usage() } },
  ]
  sendSse(res, events)
}

function sendResponsesToolCall(res, model, name, argsObj) {
  const id = `resp_${mainRequestCount}`
  const fcId = `fc_${mainRequestCount}`
  const callId = `call_${mainRequestCount}`
  const argsStr = JSON.stringify(argsObj)
  const events = [
    { type: "response.created", response: { id, created_at: Math.floor(Date.now() / 1000), model } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: fcId, call_id: callId, name, arguments: "" },
    },
    { type: "response.function_call_arguments.delta", item_id: fcId, output_index: 0, delta: argsStr },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", id: fcId, call_id: callId, name, arguments: argsStr, status: "completed" },
    },
    { type: "response.completed", response: { usage: usage() } },
  ]
  sendSse(res, events)
}

function sendSse(res, events) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  res.write("data: [DONE]\n\n")
  res.end()
}

// ---- OpenAI chat completions (secondary path) ----

function chatChunk(model, delta, finishReason) {
  return {
    id: `chatcmpl_${mainRequestCount}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

function sendChatCompletion(res, model, body, step) {
  if (body.stream === false) {
    const message = step.tool_call
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_${mainRequestCount}`,
              type: "function",
              function: { name: step.tool_call.name, arguments: JSON.stringify(step.tool_call.arguments) },
            },
          ],
        }
      : { role: "assistant", content: step.text }
    const finish = step.tool_call ? "tool_calls" : "stop"
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        id: `chatcmpl_${mainRequestCount}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    )
    return
  }
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  res.write(`data: ${JSON.stringify(chatChunk(model, { role: "assistant" }, null))}\n\n`)
  if (step.tool_call) {
    res.write(
      `data: ${JSON.stringify(
        chatChunk(
          model,
          {
            tool_calls: [
              {
                index: 0,
                id: `call_${mainRequestCount}`,
                type: "function",
                function: { name: step.tool_call.name, arguments: "" },
              },
            ],
          },
          null,
        ),
      )}\n\n`,
    )
    res.write(
      `data: ${JSON.stringify(
        chatChunk(
          model,
          {
            tool_calls: [
              {
                index: 0,
                id: `call_${mainRequestCount}`,
                type: "function",
                function: { name: step.tool_call.name, arguments: JSON.stringify(step.tool_call.arguments) },
              },
            ],
          },
          null,
        ),
      )}\n\n`,
    )
    res.write(`data: ${JSON.stringify(chatChunk(model, {}, "tool_calls"))}\n\n`)
  } else {
    res.write(`data: ${JSON.stringify(chatChunk(model, { content: step.text }, null))}\n\n`)
    res.write(`data: ${JSON.stringify(chatChunk(model, {}, "stop"))}\n\n`)
  }
  res.write("data: [DONE]\n\n")
  res.end()
}

// ---- failure modes (the provider error classes the V1 fallback hooks
// branch on; observed error mapping on host 2.4.1 in the evidence) ----

function errorBody(modeName) {
  const messages = {
    fail: ["v2-fake-model: internal error", "server_error", "internal"],
    "fail-401": ["v2-fake-model: invalid api key", "invalid_request_error", "invalid_api_key"],
    "fail-429": ["v2-fake-model: rate limited", "rate_limit_error", undefined],
    "fail-404-model": ["v2-fake-model: model not found", "invalid_request_error", "model_not_found"],
    "fail-400-overflow": ["v2-fake-model: context length exceeded", "invalid_request_error", "context_length_exceeded"],
  }
  const [message, type, code] = messages[modeName]
  const error = code ? { message, type, code } : { message, type }
  return JSON.stringify({ error })
}

function failResponse(res, modeName) {
  if (modeName === "fail-429") {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "3" }).end(errorBody(modeName))
    return
  }
  const codes = { fail: 500, "fail-401": 401, "fail-404-model": 404, "fail-400-overflow": 400 }
  res.writeHead(codes[modeName], { "content-type": "application/json" }).end(errorBody(modeName))
}

function abortResponse(res) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" })
  res.write(
    `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_abort", model: "gpt-fake" } })}\n\n`,
  )
  res.write(
    `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_abort", output_index: 0, delta: "partial" })}\n\n`,
  )
  setTimeout(() => {
    res.destroy()
  }, 50)
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok")
    return
  }

  const isResponses = req.method === "POST" && req.url.includes("/responses")
  const isChat = req.method === "POST" && req.url.includes("/chat/completions")
  if (!isResponses && !isChat) {
    res
      .writeHead(404, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "v2-fake-model: not found" }))
    return
  }

  const bodyText = await readBody(req)
  let body = {}
  try {
    body = JSON.parse(bodyText)
  } catch {
    body = {}
  }
  appendRequest(bodyText)

  if (mode !== "scenario") {
    if (mode === "fail-abort") {
      abortResponse(res)
    } else {
      failResponse(res, mode)
    }
    return
  }

  const model = typeof body.model === "string" ? body.model : "gpt-fake"
  const isMain = Array.isArray(body.tools) && body.tools.length > 0
  const step = isMain ? nextStep() : { text: "oqa-fake-aux" }

  if (isResponses) {
    if (step.tool_call) {
      sendResponsesToolCall(res, model, step.tool_call.name, step.tool_call.arguments)
    } else {
      sendResponsesText(res, model, step.text)
    }
    return
  }
  sendChatCompletion(res, model, body, step)
})

server.listen(port, "127.0.0.1", () => {
  const address = server.address()
  const bound = typeof address === "object" && address !== null ? address.port : port
  process.stdout.write(`v2-fake-model listening on ${bound}\n`)
})

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 250)
  })
}
