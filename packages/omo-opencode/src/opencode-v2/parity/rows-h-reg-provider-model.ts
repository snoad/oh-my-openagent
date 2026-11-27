import { expect } from "./bun-test-shim"

import { createHostStateSnapshot } from "../registration/host-state-snapshot"
import {
  registerProviderModelTransforms,
  type ModelRestrictionEditor,
  type ProviderModelContext,
  type ProviderModelPlanStep,
  type ProviderRegistrationEditor,
} from "../registration/provider-model"
import { buildModelMirror, buildProviderMirror } from "../registration/provider-model-contributions"
import { modelIDBrand, providerIDBrand } from "../registration/provider-model-info"
import { createPlanSource } from "../registration/plan-source"
import { EMPTY_PLAN, type RegistrationPlan } from "../registration/registration-plan"
import { createFakeV2Context, type FakeV2Context } from "./fake-v2-context"
import { defineGroup, type ParityRow } from "./rows"

// Wave-3 H-REG provider and model rows (plan task 28): the plan.provider
// contributions and the model restrictions, overrides and default land on the
// OpenCode 2 provider and model domains, replay stays idempotent and the
// recorded pre-transform state survives a reload-triggered recompute.

function registrationCtx(ctx: FakeV2Context): ProviderModelContext {
  return ctx as ProviderModelContext
}

function planWithProvider(provider: Record<string, unknown>, model?: string): RegistrationPlan {
  return { ...EMPTY_PLAN, provider, ...(model === undefined ? {} : { model }) }
}

async function runSteps(
  steps: readonly [ProviderModelPlanStep, ProviderModelPlanStep],
  plan: RegistrationPlan | undefined,
): Promise<void> {
  for (const step of steps) await step.run({ plan })
}

async function summaries(ctx: FakeV2Context): Promise<{
  providers: Array<{ id: string; models: string[] }>
  defaults: { providerID: string; modelID: string } | undefined
}> {
  let providers: Array<{ id: string; models: string[] }> = []
  let defaults: { providerID: string; modelID: string } | undefined
  await ctx.provider.transform((editor: ProviderRegistrationEditor) => {
    providers = structuredClone(
      editor.list().map((record) => ({ id: record.provider.id, models: [...record.models.keys()].sort() })),
    )
  })
  await ctx.model.transform((editor: ModelRestrictionEditor) => {
    defaults = structuredClone(editor.default.get())
  })
  return { providers, defaults }
}

async function checkProviderContributions(): Promise<void> {
  const ctx = createFakeV2Context()
  const snapshot = createHostStateSnapshot(ctx)
  const plan = planWithProvider({
    opengateway: {
      name: "OpenGateway",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://apis.opengateway.ai/v1" },
      models: {
        "claude-fable-5": {
          name: "Claude Fable 5",
          limit: { context: 1000000, output: 128000 },
          modalities: { input: ["text", "image"], output: ["text"] },
          tool_call: true,
        },
        "cost-only-entry": { cost: { input: 10, output: 50 } },
      },
    },
  })
  const steps = await registerProviderModelTransforms(registrationCtx(ctx), () => plan, snapshot)
  await steps[0]?.run({ plan })
  await ctx.provider.transform((editor: ProviderRegistrationEditor) => {
    const gateway = editor.get("opengateway")
    expect(gateway?.provider.name).toBe("OpenGateway")
    expect(gateway?.provider["package"]).toBe("@ai-sdk/openai-compatible")
    const gatewaySettings = gateway?.provider.settings as Record<string, unknown> | undefined
    expect(gatewaySettings?.["baseURL"]).toBe("https://apis.opengateway.ai/v1")
    const fable = gateway?.models.get("claude-fable-5")
    expect(fable?.modelID).toBe(modelIDBrand("claude-fable-5"))
    expect(fable?.providerID).toBe(providerIDBrand("opengateway"))
    expect(fable?.name).toBe("Claude Fable 5")
    expect(fable?.limit).toEqual({ context: 1000000, output: 128000 })
    expect(fable?.capabilities).toEqual({ tools: true, input: ["text", "image"], output: ["text"] })
    expect(gateway?.models.has("cost-only-entry")).toBe(false)
  })
}

async function checkModelRestrictions(): Promise<void> {
  const ctx = createFakeV2Context()
  const snapshot = createHostStateSnapshot(ctx)
  const plan = planWithProvider(
    {
      anthropic: {
        models: { "claude-fable-5": { name: "Claude Fable 5", limit: { context: 1000000, output: 128000 } } },
        whitelist: ["claude-fable-5"],
        blacklist: ["claude-haiku-4-5"],
      },
    },
    "anthropic/claude-fable-5",
  )
  await ctx.provider.transform((editor) => {
    editor.add({
      info: buildProviderMirror("anthropic", {}),
      models: [
        buildModelMirror("anthropic", "claude-fable-5", {}),
        buildModelMirror("anthropic", "claude-haiku-4-5", {}),
        buildModelMirror("anthropic", "claude-sonnet-5", {}),
      ],
    })
  })
  const steps = await registerProviderModelTransforms(registrationCtx(ctx), () => plan, snapshot)
  await steps[1]?.run({ plan })
  await ctx.model.transform((editor: ModelRestrictionEditor) => {
    const fable = editor.get("anthropic", "claude-fable-5")
    expect(fable?.name).toBe("Claude Fable 5")
    expect(fable?.limit).toEqual({ context: 1000000, output: 128000 })
    expect(fable?.enabled).toBe(true)
    expect(editor.get("anthropic", "claude-haiku-4-5")?.enabled).toBe(false)
    expect(editor.get("anthropic", "claude-sonnet-5")?.enabled).toBe(false)
    expect(editor.default.get()).toEqual({ providerID: "anthropic", modelID: "claude-fable-5" })
  })
}

async function checkReplaySettles(): Promise<void> {
  const ctx = createFakeV2Context()
  const source = await createPlanSource(
    ctx,
    {
      config: async (config) => {
        const providers = { ...(config.provider ?? {}) }
        if (providers["opengateway"] === undefined) {
          providers["opengateway"] = {
            name: "OpenGateway",
            models: { "claude-fable-5": { name: "Claude Fable 5", limit: { context: 1000000, output: 128000 } } },
          }
        }
        config.provider = providers
      },
    },
    {},
  )
  const steps = await registerProviderModelTransforms(registrationCtx(ctx), source.getPlan, source.snapshot)
  for (const step of steps) source.registerStep(step)
  const afterFirst = await summaries(ctx)
  const reloadCount = (): number => ctx.__calls.filter((call) => call.op === "provider.reload").length
  const listCount = (): number => ctx.__calls.filter((call) => call.op === "provider.list").length
  expect(reloadCount()).toBe(1)
  expect(listCount()).toBe(1)
  await source.recompute()
  await source.idle()
  expect(await summaries(ctx)).toEqual(afterFirst)
  expect(reloadCount()).toBe(1)
  expect(listCount()).toBe(1)
  const base = await source.snapshot.get()
  expect(Object.keys(base.provider)).toEqual(["opengateway"])
  await source.subscription.stop()
}

export const hRegProviderModelRows: ParityRow[] = defineGroup("H-REG", [
  {
    suffix: "PROVIDER-CONTRIBUTIONS",
    title:
      "the plan provider contributions land as V2 provider and model definitions and inexpressible entries are skipped",
    kind: "hermetic",
    is: ["IS-2", "IS-5"],
    wave: 3,
    status: "checked",
    check: checkProviderContributions,
  },
  {
    suffix: "MODEL-RESTRICTIONS",
    title: "model overrides, whitelist and blacklist restrictions and the plan.model default land on the right model",
    kind: "hermetic",
    is: ["IS-2"],
    wave: 3,
    status: "checked",
    check: checkModelRestrictions,
  },
  {
    suffix: "PROVIDER-MODEL-REPLAY",
    title:
      "replay is idempotent and a recorded pre-transform value survives a reload-triggered recompute without oscillation",
    kind: "hermetic",
    is: ["IS-2", "IS-5"],
    wave: 3,
    status: "checked",
    check: checkReplaySettles,
  },
])
