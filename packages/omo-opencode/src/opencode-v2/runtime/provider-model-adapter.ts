import { registerProviderModelTransforms, type ProviderModelContext } from "../registration/provider-model"
import type { V2AdapterRegistration } from "./adapters"
import type { V2RuntimePluginContext } from "./start-v2-runtime"

// Plan task 28: the provider and model contributions register on the task-23
// plan source. The plan source is created by the earlier v2-plan-source
// adapter, so its initial recompute already ran; the registration applies the
// two transforms once against that plan and registers the two recompute steps
// so every later recompute re-applies them. The plan source stays the only
// caller of the domain reloads.
export const v2ProviderModelAdapterRegistration: V2AdapterRegistration = {
  id: "v2-provider-model",
  register: async ({ ctx, runtime }) => {
    const source = runtime.planSource
    if (source === undefined) return
    const steps = await registerProviderModelTransforms(
      ctx as V2RuntimePluginContext & ProviderModelContext,
      source.getPlan,
      source.snapshot,
    )
    for (const step of steps) source.registerStep(step)
  },
}
