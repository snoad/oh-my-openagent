import { existsSync } from "node:fs"
import { spawn } from "node:child_process"

import { apiJson } from "./live-check-api"
import { fail, pass, readText, type LiveCheck, type LiveCheckContext } from "./live-check-context"

// Live check L-05 (plan task 26): the four tier-1 MCP servers are proven
// registered through the GET /api/mcp listing, or through the host log's
// "mcp connected <server>" line when the listing window misses a
// reconnecting server, and lsp_status answers through tools/list: the check
// drives a real MCP stdio handshake against the same lsp-tools-mcp server
// the host registered and asserts the status tool among the listed tools
// (the host-facing name composes as <server=lsp>_<tool=status>).

type McpListedServer = { readonly name?: unknown; readonly status?: unknown }

const REQUIRED_SERVERS = ["websearch", "context7", "grep_app", "lsp"] as const
const MCP_POLL_TIMEOUT_MS = 45_000
const TOOLS_LIST_TIMEOUT_MS = 30_000

function statusTextOf(entry: McpListedServer): string {
  if (typeof entry.status === "string") return entry.status
  if (entry.status !== null && typeof entry.status === "object") {
    const status = (entry.status as { status?: unknown }).status
    if (typeof status === "string") return status
  }
  return "unknown"
}

async function listedServersOf(ctx: LiveCheckContext): Promise<ReadonlyMap<string, string>> {
  const body = (await apiJson(ctx, "/api/mcp")) as { data?: unknown } | null
  const servers = new Map<string, string>()
  if (body === null || typeof body !== "object" || !Array.isArray(body.data)) return servers
  for (const entry of body.data) {
    if (entry === null || typeof entry !== "object") continue
    const record = entry as McpListedServer
    if (typeof record.name !== "string") continue
    servers.set(record.name, statusTextOf(record))
  }
  return servers
}

// The host log proof of registration: one "mcp connected" line per server is
// the host's own initialize + tools/list handshake result.
function hostConnectedServersOf(ctx: LiveCheckContext): ReadonlySet<string> {
  const hostLog = readText(ctx.hostLogPath)
  const connected = new Set<string>()
  for (const name of REQUIRED_SERVERS) {
    if (hostLog.includes(`mcp connected" server=${name} `) || hostLog.includes(`mcp connected" server=${name}"`)) {
      connected.add(name)
    }
  }
  return connected
}

// The lsp tools/list proof: spawn the same lsp-tools-mcp server the host
// registered, speak the newline-delimited JSON-RPC MCP stdio protocol and
// collect the tool names. The child exits when stdin closes; the deadline
// guards a hung server against leaking past the check.
async function lspToolNames(
  repoRoot: string,
): Promise<{ readonly tools: ReadonlySet<string>; readonly detail: string }> {
  const cli = `${repoRoot}/packages/lsp-tools-mcp/dist/cli.js`
  if (!existsSync(cli)) return { tools: new Set(), detail: `lsp server dist missing: ${cli}` }
  const child = spawn("node", [cli, "mcp"], { stdio: ["pipe", "pipe", "pipe"] })
  const tools = new Set<string>()
  let buffer = ""
  const write = (message: object): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  const answer = await new Promise<ReadonlySet<string>>((resolve) => {
    const deadline = setTimeout(() => resolve(tools), TOOLS_LIST_TIMEOUT_MS)
    const done = (): void => {
      clearTimeout(deadline)
      resolve(tools)
    }
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      for (;;) {
        const newlineAt = buffer.indexOf("\n")
        if (newlineAt < 0) break
        const line = buffer.slice(0, newlineAt)
        buffer = buffer.slice(newlineAt + 1)
        try {
          const message = JSON.parse(line) as { id?: unknown; result?: { tools?: Array<{ name?: unknown }> } }
          if (message.id !== 2 || !Array.isArray(message.result?.tools)) continue
          for (const tool of message.result.tools) {
            if (typeof tool?.name === "string") tools.add(tool.name)
          }
          done()
        } catch {
          // non-JSON lines are skipped
        }
      }
    })
    child.on("error", done)
    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "oqa-parity", version: "0.0.0" } },
    })
    write({ jsonrpc: "2.0", method: "notifications/initialized" })
    write({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  })
  child.stdin.end()
  child.kill()
  return {
    tools,
    detail:
      tools.size > 0
        ? `tools/list answered with ${String(tools.size)} tools`
        : `tools/list produced no answer within ${String(TOOLS_LIST_TIMEOUT_MS)}ms`,
  }
}

function repoRootOf(): string {
  return import.meta.dir.split("/packages/omo-opencode/src/opencode-v2/")[0] ?? import.meta.dir
}

export const checkMcpTiers: LiveCheck = async (ctx) => {
  const startedAt = Date.now()
  let servers: ReadonlyMap<string, string> = new Map<string, string>()
  for (;;) {
    servers = await listedServersOf(ctx)
    if (REQUIRED_SERVERS.every((name) => servers.has(name))) break
    if (Date.now() - startedAt >= MCP_POLL_TIMEOUT_MS) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const hostConnected = hostConnectedServersOf(ctx)
  const missing = REQUIRED_SERVERS.filter((name) => !servers.has(name) && !hostConnected.has(name))
  const statusLines = REQUIRED_SERVERS.map((name) => {
    const listed = servers.get(name)
    const viaLog = hostConnected.has(name) ? "host-log connected" : "not in the host log"
    return `${name}: ${listed === undefined ? "NOT LISTED" : listed} (${viaLog})`
  })
  const lsp = await lspToolNames(repoRootOf())
  const lspStatusSeen = lsp.tools.has("status")
  const evidence = [
    "L-05 PASS/FAIL: the tier-1 MCP servers are registered and lsp_status answers through tools/list.",
    `GET /api/mcp after ${String(Date.now() - startedAt)}ms: ${statusLines.join("; ")}`,
    `missing from both GET /api/mcp and the host log: ${missing.length === 0 ? "none" : missing.join(",")}`,
    `lsp tools/list handshake: ${lsp.detail} (${[...lsp.tools].sort().join(",")})`,
    `lsp_status (server lsp, tool status) in the tools/list answer: ${lspStatusSeen ? "yes" : "no"}`,
    "",
  ].join("\n")
  if (missing.length > 0) return fail(`MCP servers not proven registered: ${missing.join(",")}`, evidence)
  if (!lspStatusSeen) return fail("lsp_status never answered through the lsp server's tools/list", evidence)
  return pass(
    "websearch, context7, grep_app and lsp are registered and lsp_status answers through tools/list",
    evidence,
  )
}
