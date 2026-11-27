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
import type { AgentReplayItem, AgentReplayPermissionRule } from "./agent-replay-types"

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

type PermissionEffect = AgentReplayPermissionRule["effect"]

function effectOf(value: unknown): PermissionEffect | undefined {
  return value === "allow" || value === "deny" || value === "ask" ? value : undefined
}

// The V1 permission map keys are tool or action patterns; a flat value is the
// whole-resource rule and a scoped value renders one rule per scope, mirroring
// the V1 bash shape. First occurrence wins per (action, resource) pair, the
// V1 first-match semantics.
function permissionRulesOfMap(map: Readonly<Record<string, unknown>>, rules: AgentReplayPermissionRule[]): void {
  const seen = new Set<string>()
  const push = (action: string, resource: string, effect: PermissionEffect): void => {
    const key = `${action}\u0000${resource}`
    if (seen.has(key)) return
    seen.add(key)
    rules.push({ action, resource, effect })
  }
  for (const [action, value] of Object.entries(map)) {
    const effect = effectOf(value)
    if (effect !== undefined) {
      push(action, "*", effect)
      continue
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue
    for (const [resource, scoped] of Object.entries(value as Readonly<Record<string, unknown>>)) {
      const scopedEffect = effectOf(scoped)
      if (scopedEffect !== undefined) push(action, resource, scopedEffect)
    }
  }
}

// The V2 item's permissions ruleset: the V1 permission map first, then the
// V1 tools map (enabled renders allow, disabled renders deny; the V2 ruleset
// has no separate per-agent tool visibility field).
function permissionRulesOfV1Agent(entry: PlanAgentConfig): ReadonlyArray<AgentReplayPermissionRule> {
  const rules: AgentReplayPermissionRule[] = []
  if (typeof entry.permission === "object" && entry.permission !== null) {
    permissionRulesOfMap(entry.permission as Readonly<Record<string, unknown>>, rules)
  }
  if (typeof entry.tools === "object" && entry.tools !== null) {
    const enabled: Record<string, unknown> = {}
    const disabled: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(entry.tools as Readonly<Record<string, unknown>>)) {
      if (value === true) enabled[name] = "allow"
      if (value === false) disabled[name] = "deny"
    }
    permissionRulesOfMap(enabled, rules)
    permissionRulesOfMap(disabled, rules)
  }
  return rules
}

// Mutates the editor item in place, exactly the fields the V1 pipeline
// produced and the V2 schema carries; the host-owned request settings are
// left untouched.
export function assignAgentItem(item: AgentReplayItem, key: string, entry: PlanAgentConfig): void {
  item.name = typeof entry.name === "string" && entry.name !== "" ? entry.name : key
  item.mode = agentModeOfV1(typeof entry.mode === "string" ? entry.mode : undefined)
  item.hidden = entry.hidden === true
  const model = modelRefOfV1(entry.model)
  if (model !== undefined) item.model = model
  const system = entry.prompt
  if (typeof system === "string") item.system = system
  const description = entry.description
  if (typeof description === "string") item.description = description
  item.permissions = permissionRulesOfV1Agent(entry)
}
