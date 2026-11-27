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
    agents: diffSection(
      asRecord(base.agent) as Record<string, PlanAgentConfig>,
      asRecord(working.agent) as Record<string, PlanAgentConfig>,
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
