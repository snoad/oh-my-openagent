import { registerMcpTransform, type McpRegistrationContext } from "../registration/mcp"
import type { V2AdapterRegistration } from "./adapters"
import type { V2RuntimePluginContext } from "./start-v2-runtime"

// Plan task 26: the three MCP tiers register on the task-23 plan source as
// one recompute step with domain "mcp". The plan source is created by the
// earlier v2-plan-source adapter, so its initial recompute already ran; the
// adapter registers the step (which arms the once-per-registration mcp
// reload) and awaits one recompute so the servers land at startup. The plan
// source stays the only caller of ctx.mcp.reload(); the registration never
// calls it.
export const v2McpRegistrationAdapter: V2AdapterRegistration = {
  id: "v2-mcp-registration",
  register: async ({ ctx, runtime }) => {
    const source = runtime.planSource
    if (source === undefined) return
    const step = registerMcpTransform(
      ctx as V2RuntimePluginContext & McpRegistrationContext,
      source.getPlan,
      source.snapshot,
    )
    source.registerStep(step)
    await source.recompute()
  },
}
