// V1 AgentConfig -> V2 agent item mapping (task 24). The V1 pipeline emits
// agent entries keyed by display names plus hidden config-key aliases; each
// entry becomes one V2 Agent.Info item under the canonical id (the display
// name cut at " - " and lowercased, the same normalization the task-23 plan
// tests pin). prompt becomes system, the model string splits into the
// {providerID, id} ref, the permission map and the tools map render as the
// V2 permission ruleset, and the built-in demotion (mode plus hidden exactly
// as the pipeline wrote them) passes through. Generation settings the V2
// agent schema lacks (temperature, top_p, maxTokens, thinking) are not
// carried: they flow through the chat.params path of task 17.

import type { PlanAgentConfig } from "./registration-plan"
import type { AgentReplayItem } from "./agent-replay-types"
import { permissionRulesOfV1Agent } from "./permissions"

export type AgentMode = "primary" | "subagent" | "all"

// The canonical agent id: the plan key cut at the display suffix and
// lowercased ("Sisyphus - ultraworker" -> "sisyphus", "Sisyphus-Junior" ->
// "sisyphus-junior"). One V2 agent per canonical id; the hidden config-key
// alias normalizes to the id its display entry already registered.
export function canonicalAgentKey(key: string): string {
  return (key.split(" - ")[0] ?? key).toLowerCase()
}

function agentModeOfV1(mode: string | undefined): AgentMode {
  return mode === "primary" || mode === "subagent" || mode === "all" ? mode : "subagent"
}

function modelRefOfV1(model: unknown): { readonly id: string; readonly providerID: string } | undefined {
  if (typeof model !== "string") return undefined
  const separator = model.indexOf("/")
  if (separator <= 0 || separator === model.length - 1) return undefined
  return { providerID: model.slice(0, separator), id: model.slice(separator + 1) }
}

// Mutates the editor item in place, exactly the fields the V1 pipeline
// produced and the V2 schema carries; the host-owned request settings are
// left untouched. The ruleset is complete at write time: the per-agent rules
// plus the plan's global every-agent tool rules (task 27) render through the
// one owner in permissions.ts, so the later permission step has no editor
// work left. A name_only entry (the plan-diff promotion of an unchanged
// host agent whose V2 display name differs from the V1 key name) rewrites
// ONLY the name: the agent's other fields stay host-owned, so the lossy
// V1-permission round-trip never touches a host agent the pipeline did not
// edit.
export function assignAgentItem(
  item: AgentReplayItem,
  key: string,
  entry: PlanAgentConfig,
  globalTools: Readonly<Record<string, boolean>> = {},
): void {
  item.name = typeof entry.name === "string" && entry.name !== "" ? entry.name : key
  if (entry.name_only === true) return
  item.mode = agentModeOfV1(typeof entry.mode === "string" ? entry.mode : undefined)
  item.hidden = entry.hidden === true
  const model = modelRefOfV1(entry.model)
  if (model !== undefined) item.model = model
  const system = entry.prompt
  if (typeof system === "string") item.system = system
  const description = entry.description
  if (typeof description === "string") item.description = description
  item.permissions = permissionRulesOfV1Agent(entry, globalTools).rules
}
