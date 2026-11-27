import { registerCommandTransform, type CommandRegistrationContext } from "../registration/commands"
import type { V2AdapterRegistration } from "./adapters"
import type { V2RuntimePluginContext } from "./start-v2-runtime"

// Plan task 27: the command step joins the task-23 plan source (the skills
// contribution rides inside it) and one recompute applies both at startup.
// The plan source is the only caller of ctx.command.reload(); the static shim
// context slice omits the host command and skill transforms, so the
// registration narrows the ctx at this boundary like the mcp adapter does.
export const v2CommandRegistrationAdapter: V2AdapterRegistration = {
  id: "v2-command-registration",
  register: async ({ ctx, runtime }) => {
    const source = runtime.planSource
    if (source === undefined) return
    const step = registerCommandTransform(
      ctx as V2RuntimePluginContext & CommandRegistrationContext,
      source.getPlan,
      source.snapshot,
    )
    source.registerStep(step)
    await source.recompute()
  },
}
