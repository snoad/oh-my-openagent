// Ordered recompute step registry (task 23): the fixed pipeline order the
// registration plan recomputes through. Tools and tool snippets (plan task
// 25) run first so their data exists before the V1 config pipeline embeds
// them into the agent prompts; the config pipeline step (this task) runs
// second; the agent transform of task 24 and the remaining domains of tasks
// 26 to 28 plug in after it through registerStep.

import type { V1ConfigProjection } from "./v1-config-projection"
import type { RegistrationPlan } from "./registration-plan"
import type { HostStateSnapshot } from "./host-state-snapshot"
import type { PlanSourceContext, PlanSourceEngine } from "./plan-source-context"

const PLAN_STEP_ORDER = ["tool", "config", "agent", "permission", "mcp", "command", "provider", "model"] as const

export type PlanStepDomain = (typeof PLAN_STEP_ORDER)[number]

export type PlanStepRunInput = {
  readonly ctx: PlanSourceContext
  readonly engine: PlanSourceEngine
  readonly snapshot: HostStateSnapshot
  readonly base: V1ConfigProjection
  readonly plan?: RegistrationPlan
}

export type PlanStep = {
  readonly id: string
  readonly domain: PlanStepDomain
  readonly run: (input: PlanStepRunInput) => void | Promise<void>
}

export type PlanStepRegistry = {
  readonly register: (step: PlanStep) => void
  readonly steps: () => readonly PlanStep[]
}

export function createPlanStepRegistry(): PlanStepRegistry {
  const registered: PlanStep[] = []
  return {
    register: (step) => {
      registered.push(step)
    },
    steps: () =>
      [...registered].sort((left, right) => {
        const byDomain = PLAN_STEP_ORDER.indexOf(left.domain) - PLAN_STEP_ORDER.indexOf(right.domain)
        return byDomain !== 0 ? byDomain : 0
      }),
  }
}
