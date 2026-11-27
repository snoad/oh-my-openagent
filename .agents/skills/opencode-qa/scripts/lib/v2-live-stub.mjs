#!/usr/bin/env node
// v2-live-stub.mjs - tiny stub API for the live runner self-test (plan task
// 20). Serves canned responses from a directory: GET /api/plugin answers the
// directory's plugin.json, GET /api/session/<id>/context answers
// context-<id>.json. One-off Node server: `node v2-live-stub.mjs <port> <dir>`
// Prints "v2-live-stub listening on <port>" once bound. GET /health -> ok.

import http from "node:http"
import fs from "node:fs"
import path from "node:path"

const port = Number(process.argv[2] ?? 0)
const cannedDir = process.argv[3] ?? ""
if (!cannedDir || !fs.existsSync(cannedDir)) {
  process.stderr.write("v2-live-stub: canned dir missing\n")
  process.exit(2)
}

function sendFile(res, filePath, fallbackStatus = 404) {
  let body
  try {
    body = fs.readFileSync(filePath)
  } catch {
    res
      .writeHead(fallbackStatus, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "stub: missing" }))
    return
  }
  res.writeHead(200, { "content-type": "application/json" }).end(body)
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok")
    return
  }
  const contextMatch = req.url !== null ? /^\/api\/session\/([^/]+)\/context$/.exec(req.url) : null
  if (req.method === "GET" && contextMatch !== null) {
    sendFile(res, path.join(cannedDir, `context-${contextMatch[1]}.json`))
    return
  }
  if (req.method === "GET" && req.url === "/api/plugin") {
    sendFile(res, path.join(cannedDir, "plugin.json"))
    return
  }
  if (req.method === "GET" && req.url === "/api/agent") {
    sendFile(res, path.join(cannedDir, "agents.json"))
    return
  }
  res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "stub: not found" }))
})

server.listen(port, "127.0.0.1", () => {
  const address = server.address()
  const bound = typeof address === "object" && address !== null ? address.port : port
  process.stdout.write(`v2-live-stub listening on ${bound}\n`)
})

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 250)
  })
}
