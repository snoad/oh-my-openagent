import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

// Shared context and helpers for the live parity runner (plan task 20). The
// runner is a bun SCRIPT, not a test: every filesystem read goes through
// node:fs and every API call through fetch, so the raw-Bun runtime audit
// stays green. The shell driver writes the manifest; the checks below read
// the sandbox API, the fake model request log and the sandboxed plugin logs.

export type LiveScenarioRun = {
  readonly sessionID: string
  readonly prompt: string
  readonly requestsFile: string
  readonly eventsFile: string
  readonly directory?: string
  readonly file?: string
  readonly fileContent?: string
}

export type LiveLocation = {
  readonly name: string
  readonly directory: string
  readonly sessionID?: string
}

export type LiveIsolationReceipt = {
  // "absent" means the runner has no system opencode at all (CI); the version
  // clause is then not applicable and both version fields are null.
  readonly systemOpencode?: "present" | "absent"
  readonly systemVersionBefore?: string | null
  readonly systemVersionAfter?: string | null
  readonly dbDigestBefore?: string
  readonly dbDigestAfter?: string
  readonly sessionCountBefore?: number
  readonly sessionCountAfter?: number
  readonly method?: string
  readonly leakedSessionDirectories?: readonly string[]
  readonly ambientSessionDirectories?: readonly string[]
}

export type LiveManifest = {
  readonly wave: number
  readonly pluginId: string
  readonly serverStartEpochMs: number
  readonly pluginFirstSeenEpochMs?: number
  readonly scenarios: {
    readonly a?: LiveScenarioRun
    readonly b?: LiveScenarioRun
    readonly c?: LiveScenarioRun
    // d carries the scripted plugin grep call (L-10); e carries the tool
    // capture taken after the host config change (L-16).
    readonly d?: LiveScenarioRun
    readonly e?: LiveScenarioRun
  }
  readonly locations: readonly LiveLocation[]
  readonly tuiSmokeLog?: string
  readonly pluginFileLog?: string
  // The sandbox omo.json the driver wrote; the tool checks read the
  // disabled_tools entry out of it (L-04 tolerance, L-16 control pair).
  readonly sandboxOmoConfig?: string
  readonly sandboxPath?: string
  readonly isolation?: LiveIsolationReceipt
  readonly scriptedSteps?: Readonly<Record<string, number>>
}

// A check answers "partial" only together with a named owner: the owner says
// which later-wave task owns the deferred assertion and re-proves it.
export type LiveCheckOutcome = {
  readonly pass: true | false | "partial" | "pending" | "stop"
  readonly summary: string
  readonly evidence: string
  readonly owner?: string
}

export type LivePluginState = {
  readonly active: boolean
  readonly waitedMs: number
  readonly entryText: string
}

export type LiveCheckContext = {
  readonly manifest: LiveManifest
  readonly apiBase: string
  readonly password: string
  readonly pluginLogPath: string
  readonly hostLogPath: string
  readonly outDir: string
  readonly wave: number
  readonly phase: "live" | "post"
  pluginState: LivePluginState
}

export type LiveCheck = (ctx: LiveCheckContext) => Promise<LiveCheckOutcome>

export function readText(filePath: string): string {
  try {
    return existsSync(filePath) ? readFileSync(filePath, "utf8") : ""
  } catch {
    return ""
  }
}

export function existsSyncSafe(filePath: string): boolean {
  try {
    return existsSync(filePath)
  } catch {
    return false
  }
}

export function textLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0)
}

// Marker strings such as "[opencode-v2] hook event fired" are regex
// metacharacter minefields, so literal counting stays out of regex land.
export function countLiteral(text: string, literal: string): number {
  if (literal === "") return 0
  return text.split(literal).length - 1
}

export function readRequestBodies(requestsFile: string): string[] {
  return textLines(readText(requestsFile))
}

export type CapturedEvent = { readonly type: string; readonly sessionID?: string }

export function readCapturedEvents(eventsFile: string): CapturedEvent[] {
  const events: CapturedEvent[] = []
  for (const line of textLines(readText(eventsFile))) {
    if (!line.startsWith("data: ")) continue
    const payload = line.slice(6)
    if (payload.trim() === "" || payload === "[DONE]") continue
    try {
      const parsed = JSON.parse(payload) as { type?: unknown; data?: { sessionID?: unknown } }
      if (typeof parsed.type !== "string") continue
      const sessionID = parsed.data?.sessionID
      events.push({
        type: parsed.type,
        ...(typeof sessionID === "string" ? { sessionID } : {}),
      })
    } catch {
      // malformed SSE frames are skipped, the capture is host output
    }
  }
  return events
}

export function writeEvidenceFile(ctx: LiveCheckContext, rowId: string, evidence: string): string {
  mkdirSync(ctx.outDir, { recursive: true })
  const evidencePath = `${ctx.outDir}/${rowId}.txt`
  writeFileSync(evidencePath, evidence.endsWith("\n") ? evidence : evidence + "\n")
  return evidencePath
}

export function fail(summary: string, evidence: string): LiveCheckOutcome {
  return { pass: false, summary, evidence }
}

export function pass(summary: string, evidence: string): LiveCheckOutcome {
  return { pass: true, summary, evidence }
}

export function stop(summary: string, evidence: string): LiveCheckOutcome {
  return { pass: "stop", summary, evidence }
}

export function partial(summary: string, evidence: string, owner: string): LiveCheckOutcome {
  return { pass: "partial", summary, evidence, owner }
}

export function pendingOutcome(rowId: string, reason: string): LiveCheckOutcome {
  return {
    pass: "pending",
    summary: `${rowId} pending: ${reason}`,
    evidence: `${rowId} pending: ${reason}\n`,
    owner: reason,
  }
}
