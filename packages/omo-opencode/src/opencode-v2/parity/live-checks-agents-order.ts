// L-03 agent check helpers (plan task 24). Order assertions under the
// recorded host limit LIM-13: the OpenCode 2 host lists agents in insertion
// order (default agent first, plugin registrations interleaved by editor
// update re-insertion) and the AgentEditor offers no reorder, so the row
// asserts exactly what the host guarantees instead of the V1 baseline order:
// the default agent leads, the omo ids keep their canonical order among
// themselves, and the pre-existing host ids keep their before-capture
// relative order. The list order relative to the V1 baseline itself is never
// asserted (LIM-13 in v2-limits.ts carries the evidence). The default-agent
// surface helpers serve the same row: the session context messages carry the
// agent the run executed under, and the request carries the fixture body's
// identity line (the host recomputes the omo-model-core ref hash for the live
// model, so the fixture's first line can never match the request bytes).

const PRIMARY_ORDER = ["sisyphus", "hephaestus", "prometheus", "atlas"] as const

const OMO_ORDER = ["sisyphus", "hephaestus", "prometheus", "atlas", "metis", "momus", "sisyphus-junior"]

export function fixtureIdentityLine(prompt: string): string {
  const afterModel = prompt.split("</omo-model-core>")[1] ?? prompt
  return afterModel.split("\n").find((line) => line.startsWith('You are "')) ?? ""
}

export function contextAgentsOf(body: unknown): string[] {
  if (body === null || typeof body !== "object") return []
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const agents = new Set<string>()
  for (const message of data) {
    if (message === null || typeof message !== "object") continue
    const agent = (message as { agent?: unknown }).agent
    if (typeof agent === "string" && agent !== "") agents.add(agent)
  }
  return [...agents]
}

// The omo-model-core ref is an in-process sha256 handle over the plugin's
// native prompt context (agents/native-prompt-frame.ts: the model rebuilds
// the system prompt in the same process), so two host instances can never
// produce the same ref for identical bytes. Prompt byte equality normalizes
// it away.
export function normalizePromptRef(prompt: string): string {
  return prompt.replace(/<omo-model-core ref="[0-9a-f]{16}">/, '<omo-model-core ref="">')
}

function strictlyAscending(positions: ReadonlyArray<number>): boolean {
  return [...positions].every((position, index) => index === 0 || position > positions[index - 1])
}

export function orderProblems(beforeIds: ReadonlyArray<string>, afterIds: ReadonlyArray<string>): string[] {
  const problems: string[] = []
  const positions = PRIMARY_ORDER.map((primary) => afterIds.indexOf(primary))
  if (positions.some((position) => position < 0)) return ["a canonical primary agent is missing from the list order"]
  if (!strictlyAscending(positions)) {
    problems.push(`the four primaries are not in canonical order: ${positions.join(",")}`)
  }
  const omoPositions = OMO_ORDER.map((id) => afterIds.indexOf(id))
  if (omoPositions.some((position) => position < 0)) {
    problems.push("an omo agent is missing from the list order")
  } else if (!strictlyAscending(omoPositions)) {
    problems.push(`the omo agents are not in canonical order: ${omoPositions.join(",")}`)
  }
  if (afterIds[0] !== "sisyphus") problems.push(`the default agent does not lead the list (first: ${afterIds[0]})`)
  const beforeRank = new Map<string, number>()
  beforeIds.forEach((id, index) => beforeRank.set(id, index))
  const hostIds = beforeIds.filter((id) => !OMO_ORDER.includes(id))
  const hostRanks = hostIds.map((id) => beforeRank.get(id) ?? -1)
  if (hostRanks.some((rank) => rank < 0)) {
    problems.push("a host agent from the before capture disappeared")
  } else if (!strictlyAscending(hostRanks)) {
    problems.push("the host agents no longer keep their before-capture relative order")
  }
  return problems
}
