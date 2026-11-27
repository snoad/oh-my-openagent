import { apiJson } from "./live-check-api"
import { countLiteral, fail, pass, readText, type LiveCheck, type LiveCheckContext } from "./live-check-context"
import expectedCommands from "./fixtures/expected/commands.json"

// Live check L-06 (plan task 27): the plugin commands are listed by
// GET /api/command, and a command submission reaches the prompt hook: the
// check submits the registered stop-continuation command through the host's
// own command endpoint (POST /api/session/{id}/command, the client contract
// carrying the command name) and proves the task-16 interception marker
// "[opencode-v2] hook command.execute.before fired" lands in the sandboxed
// plugin log afterwards. That is the live answer to how a command submission
// appears to the prompt hook on 2.4.1: the host routes the named submission
// into the plugin command's execute, whose definition funnels the slash text
// back through the session admission where the prompt hook intercepts.

const LIST_POLL_TIMEOUT_MS = 45_000
const MARKER = "[opencode-v2] hook command.execute.before fired"
const MARKER_TIMEOUT_MS = 30_000
const PROBE_COMMAND = "stop-continuation"

function sessionIdOf(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined
  const candidate = (body as { data?: unknown }).data ?? body
  if (candidate !== null && typeof candidate === "object" && typeof (candidate as { id?: unknown }).id === "string") {
    return (candidate as { id: string }).id
  }
  return undefined
}

async function postJson(ctx: LiveCheckContext, path: string, body: unknown): Promise<unknown> {
  try {
    const response = await fetch(`${ctx.apiBase}${path}`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`opencode:${ctx.password}`)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) return undefined
    return (await response.json()) as unknown
  } catch {
    return undefined
  }
}

async function listedCommandNames(ctx: LiveCheckContext): Promise<ReadonlySet<string>> {
  const body = (await apiJson(ctx, "/api/command")) as { data?: unknown } | unknown[] | null
  const entries = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown })?.data)
      ? (body as { data: unknown[] }).data
      : []
  const names = new Set<string>()
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue
    const name = (entry as { name?: unknown }).name
    if (typeof name === "string") names.add(name)
  }
  return names
}

export const checkCommandsListed: LiveCheck = async (ctx) => {
  const startedAt = Date.now()
  let listed: ReadonlySet<string> = new Set()
  for (;;) {
    listed = await listedCommandNames(ctx)
    if ([...expectedCommands].every((name) => listed.has(name))) break
    if (Date.now() - startedAt >= LIST_POLL_TIMEOUT_MS) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const missing = [...expectedCommands].filter((name) => !listed.has(name))
  const markerBefore = countLiteral(readText(ctx.pluginLogPath), MARKER)

  let sessionID: string | undefined
  if (missing.length === 0) {
    const created = await postJson(ctx, "/api/session", { title: "oqa-l06-command-probe" })
    sessionID = sessionIdOf(created)
    if (sessionID !== undefined) {
      await postJson(ctx, `/api/session/${encodeURIComponent(sessionID)}/command`, {
        name: PROBE_COMMAND,
        text: "",
      })
      const markerStartedAt = Date.now()
      for (;;) {
        if (countLiteral(readText(ctx.pluginLogPath), MARKER) > markerBefore) break
        if (Date.now() - markerStartedAt >= MARKER_TIMEOUT_MS) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  }
  const markerAfter = countLiteral(readText(ctx.pluginLogPath), MARKER)
  const relaySeen = markerAfter > markerBefore
  const evidence = [
    "L-06 PASS/FAIL: plugin commands are listed by GET /api/command and a command submission reaches the prompt hook.",
    `GET /api/command after ${String(Date.now() - startedAt)}ms: ${String(listed.size)} commands listed`,
    `expected fixture commands: ${String(expectedCommands.length)}; missing: ${missing.length === 0 ? "none" : missing.join(",")}`,
    `command submission probe: session ${sessionID ?? "not created"}, command ${PROBE_COMMAND} submitted${sessionID === undefined ? " (no session)" : ""}`,
    `plugin log marker '${MARKER}' before=${String(markerBefore)} after=${String(markerAfter)}`,
    `the slash name reached the prompt hook through the command relay: ${relaySeen ? "yes" : "no"}`,
    "",
  ].join("\n")
  if (missing.length > 0) return fail(`commands missing from GET /api/command: ${missing.join(",")}`, evidence)
  if (!relaySeen)
    return fail(`the ${PROBE_COMMAND} submission never reached the prompt hook (LIM-1 evidence class)`, evidence)
  return pass("the plugin commands are listed and the submitted command's slash name reached the prompt hook", evidence)
}
