import { describe, expect, test } from "bun:test"

import { createFakeV2Context } from "../parity/fake-v2-context"
import { V2_LIMITS } from "../parity/v2-limits"
import { recordSessionModelOverride, resetSessionModelOverridesForTesting } from "./model-override-store"
import { registerModelResolveAdapter, type V2ModelResolveEvent } from "./adapt-model-resolve"
import { registerPromptHookAdapter } from "./adapt-prompt-hook"

const SESSION = "ses_model_resolve"

function resolveEvent(input: { readonly providerID: string; readonly modelID: string }): V2ModelResolveEvent {
  return { sessionID: SESSION, model: { id: input.modelID, providerID: input.providerID } }
}

function createHarness(): ReturnType<typeof createFakeV2Context> {
  const ctx = createFakeV2Context()
  registerModelResolveAdapter({
    ctx,
    runtime: {
      directory: ctx.location.directory,
      engine: {},
      tracker: { releasedDeps: new Set(), sharedHandles: [] },
      abort: new AbortController(),
      stop: async () => {},
      stopped: false,
    },
  })
  return ctx
}

describe("adapt-model-resolve #given a recorded same-provider override", () => {
  test("#when the resolve hook fires #then the model id is switched within the provider and the override is consumed", async () => {
    resetSessionModelOverridesForTesting()
    const ctx = createHarness()
    recordSessionModelOverride(SESSION, { providerID: "openai", modelID: "gpt-6-ultrawork" })
    const event = resolveEvent({ providerID: "openai", modelID: "gpt-6" })
    await ctx.__fire("session", "experimental.model.resolve", event)
    expect(event.model.id).toBe("gpt-6-ultrawork")
    expect(event.model.providerID).toBe("openai")
    await ctx.__fire("session", "experimental.model.resolve", resolveEvent({ providerID: "openai", modelID: "gpt-6" }))
    expect(event.model.id).toBe("gpt-6-ultrawork")
  })
})

describe("adapt-model-resolve #given a recorded cross-provider override", () => {
  test("#when the resolve hook fires #then the model is untouched and exactly one drop line is logged", async () => {
    resetSessionModelOverridesForTesting()
    const ctx = createHarness()
    recordSessionModelOverride(SESSION, { providerID: "anthropic", modelID: "claude-opus-5" })
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...values: unknown[]) => {
      warnings.push(values.map((value) => String(value)).join(" "))
    }
    const event = resolveEvent({ providerID: "openai", modelID: "gpt-6" })
    try {
      await ctx.__fire("session", "experimental.model.resolve", event)
    } finally {
      console.warn = originalWarn
    }
    expect(event.model.id).toBe("gpt-6")
    expect(event.model.providerID).toBe("openai")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("anthropic/claude-opus-5")
    expect(warnings[0]).toContain("LIM-3")
  })
})

describe("adapt-model-resolve #given no recorded override", () => {
  test("#when the resolve hook fires #then the model is untouched", async () => {
    resetSessionModelOverridesForTesting()
    const ctx = createHarness()
    const event = resolveEvent({ providerID: "openai", modelID: "gpt-6" })
    await ctx.__fire("session", "experimental.model.resolve", event)
    expect(event.model.id).toBe("gpt-6")
  })
})

describe("adapt-model-resolve #given the end-to-end prompt flow", () => {
  test("#when chat.message requests a same-provider model and the resolve hook fires #then the override is applied", async () => {
    resetSessionModelOverridesForTesting()
    const ctx = createFakeV2Context()
    await ctx.session.create({ id: SESSION, model: { id: "gpt-6", providerID: "openai" } })
    const runtime = {
      directory: ctx.location.directory,
      engine: {
        "chat.message": async (
          _input: { readonly sessionID: string },
          output: { readonly message: { model: { providerID: string; modelID: string } } },
        ) => {
          output.message.model = { providerID: "openai", modelID: "gpt-6-ultrawork" }
        },
      },
      tracker: { releasedDeps: new Set(), sharedHandles: [] },
      abort: new AbortController(),
      stop: async () => {},
      stopped: false,
    }
    registerPromptHookAdapter({ ctx, runtime })
    registerModelResolveAdapter({ ctx, runtime })
    await ctx.session.prompt({ sessionID: SESSION, text: "run it" })
    const event = resolveEvent({ providerID: "openai", modelID: "gpt-6" })
    await ctx.__fire("session", "experimental.model.resolve", event)
    expect(event.model.id).toBe("gpt-6-ultrawork")
  })
})

describe("adapt-model-resolve #given the limits ledger", () => {
  test("#then LIM-3 stays a candidate with attached cross-provider evidence", () => {
    const lim3 = V2_LIMITS.find((limit) => limit.id === "LIM-3")
    expect(lim3?.status).toBe("candidate")
    expect(lim3?.apiEvidence).toContain("experimental.model.resolve")
    expect(lim3?.apiEvidence).toContain("@opencode/plugin")
  })
})
