import { apiJson } from "./live-check-api"
import { fail, pass, readText, textLines, type LiveCheck, type LiveCheckContext } from "./live-check-context"

// Live checks for the plugin lifecycle rows (plan task 20): L-01 the plugin
// id is active in GET /api/plugin, L-02 the sandboxed host log carries no
// plugin error line, L-20 the plugin reached the active state within 60 s of
// server start. Every check runs after the runner's shared awaitPluginActive
// wait, so early HTTP reads never race the activation.

const PLUGIN_ERROR_PATTERN = /Plugin must export|LoadError|error/

function pluginEntryOf(body: unknown, pluginId: string): { id: string; status: string } | undefined {
  if (body === null || typeof body !== "object") return undefined
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return undefined
  for (const entry of data) {
    if (entry === null || typeof entry !== "object") continue
    const record = entry as { id?: unknown; state?: { status?: unknown } }
    if (record.id !== pluginId) continue
    return { id: String(record.id), status: typeof record.state?.status === "string" ? record.state.status : "" }
  }
  return undefined
}

function readHostLog(ctx: LiveCheckContext): string {
  return readText(ctx.hostLogPath)
}

// L-01: GET /api/plugin contains id oh-my-openagent with status "active".
export const checkPluginActive: LiveCheck = async (ctx) => {
  const pluginId = ctx.manifest.pluginId
  const body = await apiJson(ctx, "/api/plugin")
  if (body === undefined) {
    return fail(
      "GET /api/plugin did not answer",
      `L-01 FAIL: GET /api/plugin did not answer within the check timeout.\napiBase: ${ctx.apiBase}\nwaitedMs: ${ctx.pluginState.waitedMs}\n`,
    )
  }
  const entry = pluginEntryOf(body, pluginId)
  if (entry === undefined) {
    return fail(
      `plugin id ${pluginId} missing from GET /api/plugin`,
      `L-01 FAIL: plugin id '${pluginId}' not listed in GET /api/plugin.\nobserved data: ${JSON.stringify(body).slice(0, 2000)}\n`,
    )
  }
  if (entry.status !== "active") {
    return fail(
      `plugin ${pluginId} status '${entry.status}' (want active)`,
      `L-01 FAIL: plugin '${pluginId}' status is '${entry.status}', expected 'active'.\nentry: ${ctx.pluginState.entryText}\n`,
    )
  }
  return pass(
    `plugin ${pluginId} active in GET /api/plugin (waited ${ctx.pluginState.waitedMs} ms)`,
    `L-01 PASS: plugin '${pluginId}' state.status = 'active' in GET /api/plugin.\nentry: ${ctx.pluginState.entryText}\nwaitedMs: ${ctx.pluginState.waitedMs}\n`,
  )
}

// L-02: no sandboxed log line with role=server matching "Plugin must export",
// "LoadError" or a plugin error.
export const checkNoPluginLoadError: LiveCheck = async (ctx) => {
  const hostLog = textLines(readHostLog(ctx))
  const serverLines = hostLog.filter((line) => line.includes("role=server"))
  const offenders = serverLines.filter((line) => PLUGIN_ERROR_PATTERN.test(line))
  const evidence = [
    `L-02 ${offenders.length === 0 ? "PASS" : "FAIL"}: sandboxed host log plugin-error scan.`,
    `host log: ${ctx.hostLogPath}`,
    `role=server lines scanned: ${serverLines.length}`,
    `pattern: ${PLUGIN_ERROR_PATTERN.source}`,
    offenders.length === 0 ? "no matching line" : "matching lines:",
    ...offenders.slice(0, 20).map((line) => `  ${line}`),
    "",
  ].join("\n")
  if (offenders.length > 0) {
    return fail(`${offenders.length} plugin error line(s) in the sandboxed host log`, evidence)
  }
  return pass("no plugin error line in the sandboxed host log", evidence)
}

// L-20: the plugin reaches the active state within 60 s of server start. The
// manifest carries the driver's first-seen timestamp (the driver polls the
// plugin list from server start, so the first-seen time is the activation
// time within one poll interval).
export const checkPluginActiveWithin60s: LiveCheck = async (ctx) => {
  const start = ctx.manifest.serverStartEpochMs
  const firstSeen = ctx.manifest.pluginFirstSeenEpochMs
  if (typeof firstSeen !== "number") {
    return fail(
      "manifest carries no pluginFirstSeenEpochMs",
      "L-20 FAIL: the driver did not record pluginFirstSeenEpochMs; the activation window cannot be measured.\n",
    )
  }
  const elapsedMs = firstSeen - start
  const ok = elapsedMs >= 0 && elapsedMs <= 60_000 && ctx.pluginState.active
  const evidence = [
    `L-20 ${ok ? "PASS" : "FAIL"}: plugin activation window.`,
    `serverStartEpochMs: ${start}`,
    `pluginFirstSeenEpochMs: ${firstSeen}`,
    `elapsedMs: ${elapsedMs} (budget 60000)`,
    `runner-observed active: ${ctx.pluginState.active} (waited ${ctx.pluginState.waitedMs} ms)`,
    `entry: ${ctx.pluginState.entryText}`,
    "",
  ].join("\n")
  if (!ctx.pluginState.active) {
    return fail("plugin not active when the runner checked", evidence)
  }
  if (elapsedMs < 0 || elapsedMs > 60_000) {
    return fail(`plugin activation took ${elapsedMs} ms (budget 60000)`, evidence)
  }
  return pass(`plugin active ${elapsedMs} ms after server start (budget 60000)`, evidence)
}
