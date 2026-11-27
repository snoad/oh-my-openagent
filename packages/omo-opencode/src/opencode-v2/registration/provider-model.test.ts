import { describe, expect, it } from "bun:test"

import { createFakeV2Context, type FakeV2Context } from "../parity/fake-v2-context"
import { createHostStateSnapshot } from "./host-state-snapshot"
import { createPlanSource } from "./plan-source"
import {
  registerProviderModelTransforms,
  type ModelRestrictionEditor,
  type ProviderModelContext,
  type ProviderModelPlanStep,
  type ProviderRegistrationEditor,
} from "./provider-model"
import { buildModelMirror, buildProviderMirror } from "./provider-model-contributions"
import { EMPTY_PLAN, type RegistrationPlan } from "./registration-plan"
import type { V1WorkingConfig } from "./v1-config-projection"

function asRegistrationContext(ctx: FakeV2Context): ProviderModelContext {
  return ctx as ProviderModelContext
}

async function providerView(ctx: FakeV2Context, visit: (editor: ProviderRegistrationEditor) => void): Promise<void> {
  await ctx.provider.transform(visit)
}

async function modelView(ctx: FakeV2Context, visit: (editor: ModelRestrictionEditor) => void): Promise<void> {
  await ctx.model.transform(visit)
}

async function listSummaries(ctx: FakeV2Context): Promise<{
  providers: Array<{ id: string; models: string[] }>
  models: string[]
  defaultModel: { providerID: string; modelID: string } | undefined
}> {
  let providers: Array<{ id: string; models: string[] }> = []
  let models: string[] = []
  let defaultModel: { providerID: string; modelID: string } | undefined
  await providerView(ctx, (editor) => {
    providers = structuredClone(
      editor.list().map((record) => ({ id: record.provider.id, models: [...record.models.keys()].sort() })),
    )
  })
  await modelView(ctx, (editor) => {
    models = structuredClone(
      editor
        .list()
        .map((model) => model.modelID)
        .sort(),
    )
    defaultModel = structuredClone(editor.default.get())
  })
  return { providers, models, defaultModel }
}

function planWithProvider(provider: Record<string, unknown>, model?: string): RegistrationPlan {
  return { ...EMPTY_PLAN, provider, ...(model === undefined ? {} : { model }) }
}

function stubProviderPipeline(): { config: (config: V1WorkingConfig) => Promise<void> } {
  return {
    config: async (config) => {
      const providers = { ...(config.provider ?? {}) }
      if (providers["opengateway"] === undefined) {
        providers["opengateway"] = {
          name: "OpenGateway",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://apis.opengateway.ai/v1" },
          models: {
            "claude-fable-5": { name: "Claude Fable 5", limit: { context: 1000000, output: 128000 }, tool_call: true },
          },
        }
      }
      config.provider = providers
    },
  }
}

async function runSteps(
  steps: readonly [ProviderModelPlanStep, ProviderModelPlanStep],
  plan: RegistrationPlan | undefined,
): Promise<void> {
  for (const step of steps) await step.run({ plan })
}

describe("registerProviderModelTransforms", () => {
  it("#given a plan with an opengateway-style provider and a settings-only provider #when the provider step runs #then each V1 provider contribution lands as the right V2 definition", async () => {
    // given
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
        },
      },
      "settings-only": { options: { baseURL: "https://api.example/v1", headers: { "x-initiator": "omo" } } },
    })
    const steps = await registerProviderModelTransforms(asRegistrationContext(ctx), () => plan, snapshot)

    // when
    await steps[0]?.run({ plan })

    // then
    await providerView(ctx, (editor) => {
      const gateway = editor.get("opengateway")
      expect(gateway?.provider.name).toBe("OpenGateway")
      expect(gateway?.provider["package"]).toBe("@ai-sdk/openai-compatible")
      expect(gateway?.provider.settings?.["baseURL"]).toBe("https://apis.opengateway.ai/v1")
      const fable = gateway?.models.get("claude-fable-5")
      expect(fable?.id).toBe("claude-fable-5")
      expect(fable?.modelID).toBe("claude-fable-5")
      expect(fable?.providerID).toBe("opengateway")
      expect(fable?.name).toBe("Claude Fable 5")
      expect(fable?.enabled).toBe(true)
      expect(fable?.limit).toEqual({ context: 1000000, output: 128000 })
      expect(fable?.capabilities).toEqual({ tools: true, input: ["text", "image"], output: ["text"] })
      const settingsOnly = editor.get("settings-only")
      expect(settingsOnly?.provider.name).toBe("settings-only")
      expect(settingsOnly?.provider.settings?.["baseURL"]).toBe("https://api.example/v1")
      expect(settingsOnly?.provider.headers).toEqual({ "x-initiator": "omo" })
      expect(settingsOnly?.models.size).toBe(0)
    })
  })

  it("#given a provider entry whose model carries only fields the V2 model schema cannot express #when the steps run #then the entry is reported once and the expressible entries still register", async () => {
    // given
    const ctx = createFakeV2Context()
    const snapshot = createHostStateSnapshot(ctx)
    const plan = planWithProvider({
      opengateway: {
        name: "OpenGateway",
        models: {
          "cost-only": { cost: { input: 10, output: 50 } },
          expressible: { name: "Expressible", limit: { context: 200000, output: 64000 } },
        },
      },
    })
    const reported: string[] = []
    const steps = await registerProviderModelTransforms(asRegistrationContext(ctx), () => plan, snapshot, {
      onUnsupportedEntry: (entry) => reported.push(entry),
    })

    // when
    await runSteps(steps, plan)

    // then
    expect(reported).toEqual(["opengateway/cost-only"])
    await providerView(ctx, (editor) => {
      expect(editor.get("opengateway")?.models.has("cost-only")).toBe(false)
      expect(editor.get("opengateway")?.models.has("expressible")).toBe(true)
    })
    await runSteps(steps, plan)
    expect(reported).toEqual(["opengateway/cost-only"])
  })

  it("#given a plan with model overrides, whitelist and blacklist restrictions and a default model #when the model step runs #then every restriction and override lands on the right model and the default is set", async () => {
    // given
    const ctx = createFakeV2Context()
    const snapshot = createHostStateSnapshot(ctx)
    const plan = planWithProvider(
      {
        anthropic: {
          models: { "claude-fable-5": { name: "Claude Fable 5", limit: { context: 1000000, output: 128000 } } },
          whitelist: ["claude-fable-5", "claude-sonnet-5"],
          blacklist: ["claude-sonnet-5"],
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
    const steps = await registerProviderModelTransforms(asRegistrationContext(ctx), () => plan, snapshot)

    // when
    await steps[1]?.run({ plan })

    // then
    await modelView(ctx, (editor) => {
      const fable = editor.get("anthropic", "claude-fable-5")
      expect(fable?.name).toBe("Claude Fable 5")
      expect(fable?.limit).toEqual({ context: 1000000, output: 128000 })
      expect(fable?.enabled).toBe(true)
      expect(editor.get("anthropic", "claude-haiku-4-5")?.enabled).toBe(false)
      expect(editor.get("anthropic", "claude-sonnet-5")?.enabled).toBe(false)
      expect(editor.default.get()).toEqual({ providerID: "anthropic", modelID: "claude-fable-5" })
    })
  })

  it("#given steps applied twice on the same ctx #when the second run replays #then the provider and model lists are unchanged (no duplicate contributions)", async () => {
    // given
    const ctx = createFakeV2Context()
    const snapshot = createHostStateSnapshot(ctx)
    const plan = planWithProvider({
      opengateway: {
        name: "OpenGateway",
        models: { "claude-fable-5": { name: "Claude Fable 5", limit: { context: 1000000, output: 128000 } } },
      },
    })
    const steps = await registerProviderModelTransforms(asRegistrationContext(ctx), () => plan, snapshot)
    const afterFirst = await listSummaries(ctx)

    // when
    await runSteps(steps, plan)
    const afterSecond = await listSummaries(ctx)
    await ctx.__replay("provider")
    await ctx.__replay("model")
    const afterFreshReplay = await listSummaries(ctx)

    // then
    expect(afterSecond).toEqual(afterFirst)
    expect(afterFreshReplay).toEqual(afterFirst)
    expect(afterFirst.providers).toEqual([{ id: "opengateway", models: ["claude-fable-5"] }])
  })

  it("#given the transforms record before editing #when a second replay runs #then the base carries the recorded provider models and the applied default model", async () => {
    // given
    const ctx = createFakeV2Context()
    const snapshot = createHostStateSnapshot(ctx)
    const plan = planWithProvider(
      { opengateway: { name: "OpenGateway", models: { "claude-fable-5": { name: "Claude Fable 5" } } } },
      "opengateway/claude-fable-5",
    )
    const steps = await registerProviderModelTransforms(asRegistrationContext(ctx), () => plan, snapshot)
    const pristine = await snapshot.get()
    expect(pristine.provider).toEqual({})
    expect(pristine.model).toBeUndefined()

    // when: the next replay records the post-first-apply state as its pre-transform value
    await runSteps(steps, plan)
    const settled = await snapshot.get()

    // then
    expect(Object.keys(settled.provider)).toEqual(["opengateway"])
    expect(settled.provider["opengateway"]?.models?.["claude-fable-5"]?.name).toBe("Claude Fable 5")
    expect(settled.model).toBe("opengateway/claude-fable-5")
  })

  it("#given a plan source over the fake ctx #when the steps are registered and a reload-triggered recompute lands #then the recorded pre-transform value survives and nothing oscillates", async () => {
    // given
    const ctx = createFakeV2Context()
    const source = await createPlanSource(ctx, stubProviderPipeline(), {})
    const steps = await registerProviderModelTransforms(asRegistrationContext(ctx), source.getPlan, source.snapshot)
    for (const step of steps) source.registerStep(step)
    const afterFirst = await listSummaries(ctx)
    const reloadCount = (): number => ctx.__calls.filter((call) => call.op === "provider.reload").length
    expect(reloadCount()).toBe(1)
    expect(ctx.__calls.filter((call) => call.op === "provider.list").length).toBe(1)

    // when: a recompute lands after the first application (the real trigger is
    // the reload's own provider.updated event; the plan-source tests cover that
    // event path, so the recompute runs directly here for determinism)
    await source.recompute()
    await source.idle()

    // then: the lists are unchanged, the single pending registration reload
    // fired once (the reload-gating contract) and the provider domain is never re-read
    const afterSecond = await listSummaries(ctx)
    expect(afterSecond).toEqual(afterFirst)
    expect(reloadCount()).toBe(2)
    expect(ctx.__calls.filter((call) => call.op === "provider.list").length).toBe(1)

    // when: a recompute lands after the steps re-recorded their replay base
    // (the plan settles onto the re-recorded provider value) and then nothing changes
    await source.recompute()
    await source.idle()
    await source.recompute()
    await source.idle()

    // then: the degrade-driven settle reload fired at most once and no oscillation follows
    expect(reloadCount()).toBe(3)
    expect(ctx.__calls.filter((call) => call.op === "provider.list").length).toBe(1)
    await source.subscription.stop()
  })

  it("#given a model entry whose derived item misses a required Model.Info field #when the provider step runs #then the entry is skipped and reported once and the host never sees it", async () => {
    // given: a fractional limit derives limit.context outside the pinned
    // integer schema (the completeness guard rejects it before the handover)
    const ctx = createFakeV2Context()
    const snapshot = createHostStateSnapshot(ctx)
    const plan = planWithProvider({
      opengateway: {
        name: "OpenGateway",
        models: {
          broken: { name: "Broken", limit: { context: 1048.5, output: 100 } },
          complete: { name: "Complete", limit: { context: 1000, output: 100 } },
        },
      },
    })
    const reported: string[] = []
    const steps = await registerProviderModelTransforms(asRegistrationContext(ctx), () => plan, snapshot, {
      onUnsupportedEntry: (entry) => reported.push(entry),
    })

    // when
    await steps[0]?.run({ plan })

    // then
    expect(reported).toEqual(["opengateway/broken"])
    await providerView(ctx, (editor) => {
      expect(editor.get("opengateway")?.models.has("broken")).toBe(false)
      expect(editor.get("opengateway")?.models.has("complete")).toBe(true)
    })
    await steps[0]?.run({ plan })
    expect(reported).toEqual(["opengateway/broken"])
  })

  it("#given steps without a plan #when the transforms run #then nothing is applied and the pristine state is still recorded", async () => {
    // given
    const ctx = createFakeV2Context()
    const snapshot = createHostStateSnapshot(ctx)

    // when
    await registerProviderModelTransforms(asRegistrationContext(ctx), () => undefined, snapshot)

    // then
    const base = await snapshot.get()
    expect(base.provider).toEqual({})
    expect(base.model).toBeUndefined()
    const summaries = await listSummaries(ctx)
    expect(summaries.providers).toEqual([])
  })
})
