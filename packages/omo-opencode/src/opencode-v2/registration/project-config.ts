// computeRegistrationPlan (task 23 of the opencode-v2-compat plan): clone the
// pristine task-22 base, run the REAL V1 config handler over the clone (the
// six-phase pipeline of SRC/plugin-handlers/config-handler.ts plus the agent
// prompt rewrite of SRC/plugin-interface.ts), and diff the result into the
// plain JSON registration plan. The handler rejection propagates: the runtime
// reports a failed setup instead of registering a partial plan.

import { diffConfigs } from "./plan-diff"
import type { RegistrationPlan } from "./registration-plan"
import type { V1ConfigProjection, V1WorkingConfig } from "./v1-config-projection"

export type V1ConfigPipeline = {
  readonly config: (config: V1WorkingConfig) => Promise<void> | void
}

export type ComputeRegistrationPlanInput = {
  readonly base: V1ConfigProjection
  readonly pluginHooks: V1ConfigPipeline
}

export async function computeRegistrationPlan(input: ComputeRegistrationPlanInput): Promise<RegistrationPlan> {
  const { unmapped: _dropped, ...working } = structuredClone(input.base)
  await input.pluginHooks.config(working)
  return diffConfigs(input.base, working)
}
