import { registerToolTransform, type ToolRegistrationContext } from "../registration/tools"
import type { V2Runtime } from "./stop-v2-runtime"
import type { V2RuntimePluginContext } from "./start-v2-runtime"

// Plan task 25: the plugin tools register on OpenCode 2 through one recompute
// step with domain "tool" on the task-23 plan source. The adapter wires the
// runtime pieces (plan source, snapshot, engine hooks) into
// registerToolTransform and awaits the initial recompute so the tools are
// visible before any later adapter or session starts. The static shim context
// slice omits the host tool transform, so the registration narrows the ctx
// tool domain at that boundary (the real host and the hermetic fake both
// carry transform).

const v2ToolRegistrationAdapterRegistration = {
  id: "v2-tool-registration",
  register: ({ ctx, runtime }: { readonly ctx: V2RuntimePluginContext; readonly runtime: V2Runtime }) => {
    const planSource = runtime.planSource
    if (planSource === undefined) throw new Error("[opencode-v2] tool registration: plan source missing")
    return registerToolTransform(
      {
        planSource,
        tool: ctx.tool as V2RuntimePluginContext["tool"] & ToolRegistrationContext["tool"],
      },
      runtime.engine,
      planSource.snapshot,
    )
  },
}

export const v2ToolRegistrationAdapter = v2ToolRegistrationAdapterRegistration
