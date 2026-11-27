import { readFileSync } from "node:fs"

import { contextAgentsOf, fixtureIdentityLine, orderProblems } from "./live-checks-agents-order"

import {
  fail,
  pass,
  readRequestBodies,
  readText,
  type LiveCheck,
  type LiveCheckContext,
  type LiveScenarioRun,
} from "./live-check-context"

// Strict L-03 (plan task 24): the registered agent set on the OpenCode 2
// host equals the V1 baseline agent set. The check asserts the ordered id
// set, the per-agent mode/hidden flags and the built-in demotion against
// fixtures/v1-baseline/agents.json (display names only for the plugin
// agents: the pipeline output carries no name for host-owned built-ins),
// byte equality of every system prompt against agent-prompts.json, and the
// default agent through scenario A's request body plus the session agent
// surface. Order is the LIM-13 reduced guarantee (live-checks-agents-order).

type BaselineRow = { id: string; name: string; mode: string; hidden: unknown; native?: unknown }
type CapturedAgent = {
  id?: unknown
  name?: unknown
  mode?: unknown
  hidden?: unknown
  system?: unknown
}

type AgentsManifest = {
  readonly agentsBeforeFile?: string
  readonly agentsAfterFile?: string
  readonly hotAgentId?: string
  readonly contextAFile?: string
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown
  } catch {
    return undefined
  }
}

function envelopeData(body: unknown): CapturedAgent[] {
  if (body === null || typeof body !== "object") return []
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  return data.filter((entry): entry is CapturedAgent => entry !== null && typeof entry === "object")
}

function baselineRows(): BaselineRow[] {
  const parsed = readJson(`${import.meta.dir}/fixtures/v1-baseline/agents.json`)
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (row): row is BaselineRow => row !== null && typeof row === "object" && typeof (row as BaselineRow).id === "string",
  )
}

function promptFixtures(): Record<string, string | null> {
  const parsed = readJson(`${import.meta.dir}/fixtures/v1-baseline/agent-prompts.json`)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const prompts: Record<string, string | null> = {}
  for (const [id, prompt] of Object.entries(parsed)) {
    if (typeof prompt === "string" || prompt === null) prompts[id] = prompt
  }
  return prompts
}

function firstById(rows: ReadonlyArray<CapturedAgent>): Map<string, CapturedAgent> {
  const byId = new Map<string, CapturedAgent>()
  for (const row of rows) {
    if (typeof row.id !== "string") continue
    if (!byId.has(row.id)) byId.set(row.id, row)
  }
  return byId
}

function captureProblems(
  label: string,
  capture: Map<string, CapturedAgent>,
  baseline: BaselineRow[],
  prompts: Record<string, string | null>,
): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const row of baseline) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const item = capture.get(row.id)
    if (item === undefined) {
      problems.push(`${label}: baseline agent ${row.id} missing`)
      continue
    }
    if (item.mode !== row.mode) problems.push(`${label}: ${row.id} mode ${String(item.mode)} != baseline ${row.mode}`)
    if ((item.hidden === true) !== (row.hidden === true)) {
      problems.push(`${label}: ${row.id} hidden ${String(item.hidden)} != baseline ${String(row.hidden)}`)
    }
    // Display names are asserted only for the pipeline-named plugin agents
    // (native: false); host-owned built-ins carry no name in the pipeline
    // output, so the contract asserts the flags only.
    if (row.native !== true && item.name !== row.name) {
      problems.push(`${label}: ${row.id} name ${String(item.name)} != baseline ${row.name}`)
    }
    const prompt = prompts[row.id]
    if (prompt === undefined) problems.push(`${label}: no baseline prompt fixture for ${row.id}`)
    else if (prompt === null) {
      if (typeof item.system === "string")
        problems.push(`${label}: ${row.id} carries a system prompt although the baseline has none`)
    } else if (item.system !== prompt)
      problems.push(`${label}: ${row.id} system prompt bytes differ from the baseline fixture`)
  }
  return problems
}

function scenarioOr(ctx: LiveCheckContext, key: "a" | "b" | "c"): LiveScenarioRun | undefined {
  return (ctx.manifest.scenarios as Record<string, LiveScenarioRun | undefined>)[key]
}

export const checkAgents: LiveCheck = async (ctx) => {
  const manifest = ctx.manifest as typeof ctx.manifest & AgentsManifest
  const baseline = baselineRows()
  const prompts = promptFixtures()
  const evidence: string[] = [
    "L-03 PASS/FAIL: registered agent set equals the V1 baseline (ids, mode/hidden/name flags, demotion, prompt bytes) before and after a host config change, plus the default agent through scenario A's request.",
  ]
  if (baseline.length === 0 || Object.keys(prompts).length === 0) {
    evidence.push("baseline fixtures unreadable")
    return fail("the V1 baseline fixtures are unreadable", evidence.join("\n") + "\n")
  }
  const beforeBody = manifest.agentsBeforeFile === undefined ? undefined : readJson(manifest.agentsBeforeFile)
  const afterBody = manifest.agentsAfterFile === undefined ? undefined : readJson(manifest.agentsAfterFile)
  if (beforeBody === undefined || afterBody === undefined) {
    evidence.push(
      `agentsBeforeFile: ${manifest.agentsBeforeFile ?? "MISSING from the manifest"}`,
      `agentsAfterFile: ${manifest.agentsAfterFile ?? "MISSING from the manifest"}`,
    )
    return fail(
      "the driver captured no GET /api/agent before/after pair; the agent set is not proven",
      evidence.join("\n") + "\n",
    )
  }
  const before = firstById(envelopeData(beforeBody))
  const after = firstById(envelopeData(afterBody))
  const problems = [
    ...captureProblems("before", before, baseline, prompts),
    ...captureProblems("after", after, baseline, prompts),
  ]
  const hotId = manifest.hotAgentId
  const hotPresent = hotId === undefined ? false : after.has(hotId)
  if (!hotPresent) problems.push(`after: the hot agent ${hotId ?? "(none)"} from the host config change is missing`)
  const idsInOrder = envelopeData(afterBody)
    .map((agent) => agent.id)
    .filter((id): id is string => typeof id === "string")
  const beforeIdsInOrder = envelopeData(beforeBody)
    .map((agent) => agent.id)
    .filter((id): id is string => typeof id === "string")
  const orderProblemsFound = orderProblems(beforeIdsInOrder, idsInOrder)
  problems.push(...orderProblemsFound.map((problem) => `after: ${problem}`))
  const order = orderProblemsFound.length === 0 ? undefined : orderProblemsFound.join("; ")
  const scenario = scenarioOr(ctx, "a")
  const sisyphusPrompt = prompts["sisyphus"] ?? ""
  const bodies = scenario === undefined ? [] : readRequestBodies(scenario.requestsFile)
  const mainRequest = bodies.find((body) => body.includes('"tools":[{') || body.includes('"tools": [{'))
  const identityLine = fixtureIdentityLine(sisyphusPrompt)
  const identityEscaped = JSON.stringify(identityLine).slice(1, -1)
  const requestProvesSisyphus =
    mainRequest !== undefined &&
    identityLine !== "" &&
    (mainRequest.includes(identityLine) || mainRequest.includes(identityEscaped))
  const contextBody = manifest.contextAFile === undefined ? undefined : readJson(manifest.contextAFile)
  const sessionAgents = contextAgentsOf(contextBody)
  const contextProvesSisyphus = sessionAgents.includes("sisyphus")
  if (contextBody === undefined)
    problems.push("default: the manifest carries no contextAFile; the session agent surface is unproven")
  if (!requestProvesSisyphus)
    problems.push("default: scenario A's request does not carry the sisyphus system body (ref is per-model)")
  if (!contextProvesSisyphus)
    problems.push(`default: scenario A's session ran under: ${sessionAgents.join(",") || "(none)"}, not sisyphus`)
  evidence.push(
    `baseline ids: ${[...new Set(baseline.map((row) => row.id))].join(",")}`,
    `captured before ids: ${[...before.keys()].join(",")}`,
    `captured after ids: ${[...after.keys()].join(",")}`,
    `hot agent ${hotId ?? "(none)"} present after the config change: ${hotPresent}`,
    `registered omo order (primaries first): ${order === undefined ? "canonical" : order}`,
    `default agent proven through scenario A's request developer content: ${requestProvesSisyphus}`,
    `default agent proven through scenario A's session agent surface: ${contextProvesSisyphus} (agents: ${sessionAgents.join(",") || "none"})`,
    ...problems,
    "",
  )
  if (problems.length > 0) return fail(`${problems.length} agent-set assertion(s) failed`, evidence.join("\n"))
  return pass(
    "agent ids, flags, demotion and prompt bytes equal the V1 baseline before and after a host config change; the default agent is sisyphus",
    evidence.join("\n"),
  )
}
