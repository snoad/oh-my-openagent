// Config diff (task 23): deep-equal comparison of the pristine task-22 base
// against the V1 pipeline output, per plan section. The result carries only
// plain JSON values so it stays structured-cloneable.

import type { V1ConfigProjection, V1WorkingConfig } from "./v1-config-projection"
import type {
  PlanAgentConfig,
  PlanCommandConfig,
  PlanSection,
  PlanServerConfig,
  RegistrationPlan,
  PlanDomain,
} from "./registration-plan"

export function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => jsonDeepEqual(entry, right[index]))
  }
  if (isPlainRecord(left) && isPlainRecord(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && jsonDeepEqual(left[key], right[key]))
    )
  }
  return false
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function diffSection<T>(base: Record<string, T>, working: Record<string, T>): PlanSection<T> {
  const added: Record<string, T> = {}
  const modified: Record<string, T> = {}
  const removed: string[] = []
  for (const [key, value] of Object.entries(working)) {
    if (!(key in base)) {
      added[key] = value
    } else if (!jsonDeepEqual(base[key], value)) {
      modified[key] = value
    }
  }
  for (const key of Object.keys(base)) {
    if (!(key in working)) removed.push(key)
  }
  return { added, modified, removed }
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {}
}

export function diffConfigs(base: V1ConfigProjection, working: V1WorkingConfig): RegistrationPlan {
  const workingDefaultAgent = working.default_agent
  const defaultChanged = base.default_agent !== workingDefaultAgent
  const modelChanged = base.model !== working.model
  return {
    agents: withV1AgentNames(
      asRecord(base.agent) as Record<string, PlanAgentConfig>,
      diffSection(
        asRecord(base.agent) as Record<string, PlanAgentConfig>,
        asRecord(working.agent) as Record<string, PlanAgentConfig>,
      ),
    ),
    ...(defaultChanged && workingDefaultAgent !== undefined ? { defaultAgent: workingDefaultAgent } : {}),
    tools: asRecord(working.tools) as Record<string, boolean>,
    mcp: diffSection(
      asRecord(base.mcp) as Record<string, PlanServerConfig>,
      asRecord(working.mcp) as Record<string, PlanServerConfig>,
    ),
    commands: diffSection(
      asRecord(base.command) as Record<string, PlanCommandConfig>,
      asRecord(working.command) as Record<string, PlanCommandConfig>,
    ),
    provider: asRecord(working.provider),
    ...(modelChanged && working.model !== undefined ? { model: working.model } : {}),
  }
}

// The plan a no-op pipeline would produce over this base: the first-apply
// baseline. A domain reloads on the first apply only when the pipeline moved
// its section away from this, and afterwards only when it moved away from the
// last applied plan.
export function noopPlanOf(base: V1ConfigProjection): RegistrationPlan {
  return diffConfigs(base, base)
}

// The V1 host names its own agents by their config key (v1-baseline/agents.json:
// build, compaction, general, librarian, multimodal-looker, oracle, plan,
// summary, title, explore); the OpenCode 2 host names them display-style
// (Build, Compaction, General, ...) and the base projection carries no name,
// so EVERY unchanged base-backed agent enters the modified section as a
// name_only entry whose name is the canonical id. The registration rewrites
// the name and leaves every other field host-owned. Entries the pipeline
// actually changed keep their full working value.
function withV1AgentNames(
  base: Record<string, PlanAgentConfig>,
  section: PlanSection<PlanAgentConfig>,
): PlanSection<PlanAgentConfig> {
  const added: Record<string, PlanAgentConfig> = {}
  const modified: Record<string, PlanAgentConfig> = {}
  for (const [key, value] of Object.entries(section.added)) {
    const id = (key.split(" - ")[0] ?? key).toLowerCase()
    if (id in base) {
      modified[key] = { ...value, name: id }
      continue
    }
    added[key] = value
  }
  for (const [key, value] of Object.entries(section.modified)) {
    const id = (key.split(" - ")[0] ?? key).toLowerCase()
    modified[key] = { ...value, name: id }
  }
  for (const [key, value] of Object.entries(base)) {
    if (key in modified || key in added) continue
    const id = (key.split(" - ")[0] ?? key).toLowerCase()
    modified[key] = { ...value, name: id, name_only: true }
  }
  return { added, modified, removed: section.removed }
}

// The plan domains a recompute must reload: every section the next plan moved
// away from the comparison plan (the agents section counts the default agent
// as part of the same domain).
export function changedPlanDomains(previous: RegistrationPlan, next: RegistrationPlan): readonly PlanDomain[] {
  const changed: PlanDomain[] = []
  if (!jsonDeepEqual(previous.agents, next.agents) || !jsonDeepEqual(previous.defaultAgent, next.defaultAgent)) {
    changed.push("agents")
  }
  if (!jsonDeepEqual(previous.tools, next.tools)) changed.push("tools")
  if (!jsonDeepEqual(previous.mcp, next.mcp)) changed.push("mcp")
  if (!jsonDeepEqual(previous.commands, next.commands)) changed.push("commands")
  if (!jsonDeepEqual(previous.provider, next.provider)) changed.push("provider")
  if (!jsonDeepEqual(previous.model, next.model)) changed.push("model")
  return changed
}
