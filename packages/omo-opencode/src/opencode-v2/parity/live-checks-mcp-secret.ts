import { existsSync } from "node:fs"

import { countLiteral, fail, pass, readText, type LiveCheck, type LiveCheckContext } from "./live-check-context"

// Live check L-23 (plan task 26): the invented per-run token, allowed through
// the user-layer [opencode] mcp_env_allowlist and expanded by the V1
// pipeline, lands in the registered server's environment as a literal (the
// pinned 2.4.1 LocalConfig carries no by-name environment binding). The
// check greps the GET /api/mcp capture and the sandboxed logs for the value,
// with guards against the vacuous pass: a missing token file, a missing
// allowlist entry, a probe server that never registered, or a blocked
// expansion each fail the row even though no leak was observed.

type McpManifest = {
  readonly mcpApiCaptureFile?: string
  readonly secretTokenFile?: string
}

const MCP_SECRET_PROBE_SERVER = "oqa-secret-probe"
const MCP_SECRET_VAR = "OQA_SECRET_TOKEN"

function allowlistedOf(ctx: LiveCheckContext): boolean {
  const raw = ctx.manifest.sandboxOmoConfig === undefined ? "" : readText(ctx.manifest.sandboxOmoConfig)
  return raw.includes(MCP_SECRET_VAR)
}

function redactedMarker(token: string): string {
  return `REDACTED(${String(token.length)} chars)`
}

function occurrenceLines(token: string, surfaces: ReadonlyArray<readonly [string, string]>): string[] {
  return surfaces.map(([surface, text]) => {
    const hits = countLiteral(text, token)
    return `${surface}: ${hits === 0 ? "0" : String(hits)} occurrence(s) of ${redactedMarker(token)}`
  })
}

export const checkMcpSecretNonDisclosure: LiveCheck = async (ctx) => {
  const manifest = ctx.manifest as typeof ctx.manifest & McpManifest
  const token =
    manifest.secretTokenFile !== undefined && existsSync(manifest.secretTokenFile)
      ? readText(manifest.secretTokenFile).trim()
      : ""
  const apiCapture = manifest.mcpApiCaptureFile === undefined ? "" : readText(manifest.mcpApiCaptureFile)
  const pluginLog = readText(ctx.pluginLogPath)
  const hostLog = readText(ctx.hostLogPath)
  const pluginFileLog = ctx.manifest.pluginFileLog === undefined ? "" : readText(ctx.manifest.pluginFileLog)
  const surfaces: ReadonlyArray<readonly [string, string]> = [
    ["GET /api/mcp capture", apiCapture],
    ["serve.out", pluginLog],
    ["host log", hostLog],
    ["plugin file log", pluginFileLog],
  ]
  const blockedExpansion =
    pluginFileLog.includes("Blocked MCP env var expansion") && pluginFileLog.includes(MCP_SECRET_VAR)
  // The API listing drops servers caught between reconnects, so the probe
  // registration is proven through the capture OR the host log's connected
  // line (the same dual surface the L-05 registration proof uses).
  const probeRegistered =
    apiCapture.includes(MCP_SECRET_PROBE_SERVER) ||
    hostLog.includes(`mcp connected" server=${MCP_SECRET_PROBE_SERVER} `) ||
    hostLog.includes(`mcp connected" server=${MCP_SECRET_PROBE_SERVER}"`)
  const evidence = [
    "L-23 PASS/FAIL: the allowlisted MCP secret value appears in neither GET /api/mcp nor the sandboxed log.",
    `secret token: ${token.length === 0 ? "MISSING (vacuous-pass guard)" : redactedMarker(token)}`,
    `user-layer [opencode] mcp_env_allowlist carries ${MCP_SECRET_VAR}: ${allowlistedOf(ctx) ? "yes" : "NO (vacuous-pass guard)"}`,
    `probe server ${MCP_SECRET_PROBE_SERVER} registered (capture or host log): ${probeRegistered ? "yes" : "NO (vacuous-pass guard)"}`,
    ...occurrenceLines(token, surfaces),
    `blocked-expansion line for ${MCP_SECRET_VAR} in the plugin log: ${blockedExpansion ? "present" : "none"}`,
    "",
  ].join("\n")
  const guards: string[] = []
  if (token.length === 0) guards.push("the per-run token file was missing or empty")
  if (!allowlistedOf(ctx)) guards.push(`the sandbox omo config carries no ${MCP_SECRET_VAR} allowlist entry`)
  if (!probeRegistered) guards.push(`the probe server ${MCP_SECRET_PROBE_SERVER} never registered`)
  if (blockedExpansion)
    guards.push(`the expansion of ${MCP_SECRET_VAR} was blocked, so the value never reached the registry`)
  if (guards.length > 0) return fail(`vacuous-pass guard: ${guards.join("; ")}`, evidence)
  const leaked = surfaces.filter(([surface, text]) => countLiteral(text, token) > 0)
  if (leaked.length > 0)
    return fail(`secret value found in: ${leaked.map(([surface]) => surface).join(", ")}`, evidence)
  return pass("the expanded secret value appears in neither GET /api/mcp nor the sandboxed logs", evidence)
}
