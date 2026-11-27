// V1 permission projection onto Agent.Info.permissions (task 27 of the
// opencode-v2-compat plan). This module is the ONE owner of the
// V1-agent-to-V2-rule mapping: task 24's agent item builder imports it from
// here. Rules carry {action, resource, effect}; the action correspondence is
// the documented one (V2 shell for V1 bash, subagent for task, edit for
// write and patch; webfetch and external_directory share the name; the dotted
// mcp.use, skill.use and plugin.use pass through verbatim and any other V1
// permission key passes through as the same-named V2 action). Rules that
// apply to every agent come from the plan's global tools map and are appended
// after the per-agent rules, so an explicit per-agent rule keeps precedence
// under the host's ordered first-match evaluation and the trailing wildcard
// allow (the V1 default-allow parity) stays last. A V1 tools-map entry keyed
// by a glob pattern ("task_*") has no OpenCode 2 counterpart: the V2 action
// is a literal string with no documented pattern semantics, so the pattern is
// reported as unmapped (LIM-15), never written as a rule that could never
// match, and the request-level hiding happens in the task-17 context hook
// (hidden-tools.ts). The permission step runs after the agent step, whose
// items are already complete, and only reports.

import { log } from "../../shared"

import type { AgentReplayPermissionRule } from "./agent-replay-types"
import type { PlanStep, PlanStepRunInput } from "./plan-steps"
import type { PlanAgentConfig, RegistrationPlan } from "./registration-plan"

const PERMISSION_STEP_ID = "permission-registration"
const LOG_MARKER = "[opencode-v2] permission-registration"

// The documented action correspondence: V1 bash rules govern V2 shell, V1
// task rules govern V2 subagent, and the V1 write and patch rules govern the
// single V2 edit action. Everything else passes through under the same name
// (webfetch, external_directory, the dotted mcp.use, skill.use and
// plugin.use, and the tool names both hosts share).
const ACTION_TRANSLATION: Readonly<Record<string, string>> = {
  bash: "shell",
  task: "subagent",
  write: "edit",
  patch: "edit",
}

export function isGlobToolPattern(name: string): boolean {
  return name.includes("*") || name.includes("?") || name.includes("[")
}

type PermissionEffect = AgentReplayPermissionRule["effect"]

function effectOf(value: unknown): PermissionEffect | undefined {
  return value === "allow" || value === "deny" || value === "ask" ? value : undefined
}

// The V1 permission map keys are tool or action patterns; a flat value is the
// whole-resource rule and a scoped value renders one rule per scope, mirroring
// the V1 bash shape. First occurrence wins per (action, resource) pair, the
// V1 first-match semantics.
function permissionRulesOfMap(
  map: Readonly<Record<string, unknown>>,
  rules: AgentReplayPermissionRule[],
  seen: Set<string> = new Set<string>(),
): void {
  const push = (rawAction: string, resource: string, effect: PermissionEffect): void => {
    const action = ACTION_TRANSLATION[rawAction] ?? rawAction
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

// The V1 tools map renders as rules (enabled allow, disabled deny); entries
// keyed by glob patterns cannot become rules and are collected as unmapped.
function toolsRulesOf(
  tools: Readonly<Record<string, boolean>>,
  rules: AgentReplayPermissionRule[],
  seen: Set<string>,
  unmapped: string[],
): void {
  const enabled: Record<string, unknown> = {}
  const disabled: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(tools)) {
    if (typeof value !== "boolean") continue
    if (isGlobToolPattern(name)) {
      unmapped.push(name)
      continue
    }
    if (value) enabled[name] = "allow"
    else disabled[name] = "deny"
  }
  permissionRulesOfMap(enabled, rules, seen)
  permissionRulesOfMap(disabled, rules, seen)
}

function toolsMapOf(entry: PlanAgentConfig): Readonly<Record<string, boolean>> {
  return typeof entry.tools === "object" && entry.tools !== null && !Array.isArray(entry.tools)
    ? (entry.tools as Readonly<Record<string, boolean>>)
    : {}
}

export type AgentPermissionProjection = {
  readonly rules: ReadonlyArray<AgentReplayPermissionRule>
  readonly unmapped: readonly string[]
}

// Per-agent rules first, then the every-agent rules from the plan's global
// tools map, then the trailing wildcard allow.
export function permissionRulesOfV1Agent(
  entry: PlanAgentConfig,
  globalTools: Readonly<Record<string, boolean>>,
): AgentPermissionProjection {
  const rules: AgentReplayPermissionRule[] = []
  const unmapped: string[] = []
  const seen = new Set<string>()
  if (typeof entry.permission === "object" && entry.permission !== null) {
    permissionRulesOfMap(entry.permission as Readonly<Record<string, unknown>>, rules, seen)
  }
  toolsRulesOf(toolsMapOf(entry), rules, seen, unmapped)
  toolsRulesOf(globalTools, rules, seen, unmapped)
  rules.push({ action: "*", resource: "*", effect: "allow" })
  return { rules, unmapped }
}

// The distinct glob patterns the plan cannot express, across the global tools
// map and every touched agent entry.
export function unmappedGlobPatternsOfPlan(plan: RegistrationPlan | undefined): readonly string[] {
  if (plan === undefined) return []
  const seen = new Set<string>()
  for (const name of Object.keys(plan.tools)) {
    if (typeof plan.tools[name] === "boolean" && isGlobToolPattern(name)) seen.add(name)
  }
  for (const entry of [...Object.values(plan.agents.added), ...Object.values(plan.agents.modified)]) {
    for (const name of Object.keys(toolsMapOf(entry))) {
      if (isGlobToolPattern(name)) seen.add(name)
    }
  }
  return [...seen]
}

export function permissionStep(options?: { readonly onUnmapped?: (pattern: string) => void }): PlanStep {
  const reported = new Set<string>()
  return {
    id: PERMISSION_STEP_ID,
    domain: "permission",
    run: async ({ plan }: PlanStepRunInput) => {
      for (const pattern of unmappedGlobPatternsOfPlan(plan)) {
        if (reported.has(pattern)) continue
        reported.add(pattern)
        const message = `${LOG_MARKER}: V1 tool rule '${pattern}' has no OpenCode 2 permission counterpart; hidden at request level instead (LIM-15)`
        if (options?.onUnmapped === undefined) log(message, { pattern })
        else options.onUnmapped(pattern)
      }
    },
  }
}
