import { registerAgentTransform } from "../registration/agents"
import type { AgentReplayContext } from "../registration/agent-replay-types"
import type { V2AdapterRegistration } from "./adapters"
import type { V2RuntimePluginContext } from "./start-v2-runtime"

// Plan task 24: the agent recompute step joins the task-23 plan source and
// one recompute applies the omo agents at startup (the initial recompute ran
// inside createPlanSource before this adapter could register the step). The
// replay callback is guarded; the plan source owns the agent reload.
export const v2AgentRegistrationAdapter: V2AdapterRegistration = {
  id: "v2-agent-registration",
  register: async ({ ctx, runtime }) => {
    const source = runtime.planSource
    if (source === undefined) return
    const step = registerAgentTransform(
      ctx as V2RuntimePluginContext & AgentReplayContext,
      source.getPlan,
      source.snapshot,
    )
    source.registerStep(step)
    await source.recompute()
  },
}
