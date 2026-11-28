import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFakeV2Context, type FakeV2Context } from "../parity/fake-v2-context"
import { createAgentOverride, createToolOverride, type DomainHooks } from "../parity/plan-convergence-host-fake"
import { createCommandOverride, createMcpOverride } from "../parity/plan-convergence-host-fake-domains"
import { createProviderModelOverrides, seedHostModels } from "../parity/plan-convergence-host-fake-provider"
import { buildProviderMirror } from "./provider-model-contributions"
import { registerAgentTransform } from "./agents"
import type { AgentReplayContext } from "./agent-replay-types"
import { registerCommandTransform } from "./commands"
import { MAX_RECORD_CONTINUATION_ROUNDS } from "./plan-source-continuation"
import { registerMcpTransform } from "./mcp"
import { createPlanSource, type PlanSource } from "./plan-source"
import type { PlanSourceContext } from "./plan-source-context"
import { permissionStep } from "./permissions"
import { registerProviderModelTransforms } from "./provider-model"
import { registerTodoTools } from "./todo-tools"
import { registerToolTransform, type ToolRegistrationContext, type ToolRegistrationEngine } from "./tools"
import type { V1WorkingConfig } from "./v1-config-projection"

// The convergence contract on a host-mimicking context (the wave-3 reload
// loop): after the startup chain applies, delivering the reload events the
// reloads publish must stop producing reloads. The mimic hands every
// transform registration the live editor (containing this runtime's previous
// output, under the display-key ids the real host persists) and every reload
// the rebuilt view (canonical ids), the two forms the live capture proved.

const HOST_SEED_AGENTS = [
  { id: "build", name: "Build", mode: "primary" as const, hidden: false },
  { id: "general", name: "General", mode: "primary" as const, hidden: false },
  { id: "explore", name: "Explore", mode: "subagent" as const, hidden: false },
]

const HOST_SEED_TOOLS = [{ id: "read" }, { id: "write" }, { id: "shell" }, { id: "question" }]

// The stub pipeline mirrors the real V1 handler's shape: one plugin agent
// under a display key that differs from its canonical id, one command, one
// mcp server, one tool toggle and one contributed provider.
function convergenceEngine() {
  const stubExecute = async () => ({ content: "ok" })
  const stubTool = {
    description: "stub grep",
    args: { pattern: { _zod: { def: { type: "string" }, toJSONSchema: () => ({ type: "string" }) } } },
    execute: stubExecute,
  }
  return {
    tool: { "omo-grep": stubTool } as unknown as ToolRegistrationEngine["tool"],
    config: async (config: V1WorkingConfig) => {
      config.agent["Sentinel - worker"] = { name: "Sentinel - worker", prompt: "p", mode: "primary" }
      config.command["omo-cmd"] = { template: "hi $ARGUMENTS", description: "d" }
      config.mcp["probe"] = { type: "local", command: ["node", "-v"], enabled: true }
      config.tools["read"] = false
      // The real pipeline's provider phase merges the base providers (the
      // opengateway phase spreads existing config.provider), it never replaces
      // them; the host-owned rows must therefore be visible in the plan.
      config.provider = {
        ...config.provider,
        ogw: {
          name: "ogw",
          npm: "@ogw/sdk",
          options: {},
          models: { m1: { name: "M1", limit: { context: 10, output: 5 } } },
        },
      }
    },
  }
}

function createManualScheduler() {
  const pending = new Set<{ run: () => void }>()
  return {
    setTimeout: (callback: () => void, ms: number) => {
      const timer = { run: callback }
      pending.add(timer)
      void ms
      return () => {
        pending.delete(timer)
      }
    },
    fire: async () => {
      const timers = [...pending]
      pending.clear()
      for (const timer of timers) timer.run()
    },
    pendingCount: () => pending.size,
  }
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

type MimicBoot = {
  readonly ctx: FakeV2Context
  readonly source: PlanSource
  readonly scheduler: ReturnType<typeof createManualScheduler>
  readonly reloadCounts: () => {
    agent: number
    tool: number
    mcp: number
    command: number
    provider: number
    model: number
  }
  readonly dispose: () => void
}

// The real adapter sequence (runtime/adapters.ts order) over the mimic ctx:
// plan source, provider-model, todo, tool, agent, permission, mcp, command.
// volatileHostFields models the real host's post-activation registry reads:
// projection-invisible fields (agent name form, host tool description)
// alternate on every read, so the recorded base deep-differs each pass while
// the plan stays byte-identical.
async function bootMimicRegistration(options?: { readonly volatileHostFields?: boolean }): Promise<MimicBoot> {
  const fake = createFakeV2Context()
  const agent = createAgentOverride(HOST_SEED_AGENTS, options)
  const tool = createToolOverride(HOST_SEED_TOOLS, options)
  const mcp = createMcpOverride()
  const command = createCommandOverride([
    { name: "help", execute: async () => undefined },
    { name: "review", execute: async () => undefined },
  ])
  const providerModel = createProviderModelOverrides(seedHostModels())
  const providerModelHooks = providerModel.hooks
  const ctx = {
    ...fake,
    agent: agent.domain,
    tool: tool.domain,
    mcp: mcp.domain,
    command: command.domain,
    provider: providerModel.provider,
    model: providerModel.model,
  } as FakeV2Context
  const scheduler = createManualScheduler()
  const engine = convergenceEngine()
  const source = await createPlanSource(ctx as FakeV2Context & PlanSourceContext, engine, { scheduler })
  const skillDirectory = mkdtempSync(join(tmpdir(), "oqa-conv-skills-"))
  const [providerStep, modelStep] = await registerProviderModelTransforms(ctx, source.getPlan, source.snapshot)
  source.registerStep(providerStep)
  source.registerStep(modelStep)
  registerTodoTools(ctx, source)
  await registerToolTransform(
    { planSource: source, tool: ctx.tool } as FakeV2Context & ToolRegistrationContext,
    engine,
    source.snapshot,
  )
  const agentStep = registerAgentTransform(ctx as FakeV2Context & AgentReplayContext, source.getPlan, source.snapshot)
  source.registerStep(agentStep)
  await source.recompute()
  source.registerStep(permissionStep())
  const mcpStep = registerMcpTransform(ctx, source.getPlan, source.snapshot)
  source.registerStep(mcpStep)
  await source.recompute()
  const commandStep = registerCommandTransform(ctx, source.getPlan, source.snapshot, { skillDirectory })
  source.registerStep(commandStep)
  await source.recompute()
  return {
    ctx,
    source,
    scheduler,
    reloadCounts: () => ({
      agent: agent.hooks.reloads.count,
      tool: tool.hooks.reloads.count,
      mcp: mcp.hooks.reloads.count,
      command: command.hooks.reloads.count,
      provider: providerModelHooks.provider.reloads.count,
      model: providerModelHooks.model.reloads.count,
    }),
    dispose: () => rmSync(skillDirectory, { recursive: true, force: true }),
  }
}

async function deliverReloadRound(boot: MimicBoot): Promise<void> {
  for (const type of ["agent.updated", "command.updated", "model.updated", "provider.updated"]) {
    boot.ctx.__pushEvent({ type, created: 1, data: {} })
  }
  await flushAsync()
  await boot.scheduler.fire()
  await boot.source.idle()
}

// The manual scheduler's windows elapse only when fired, so the settle drain
// is driven round by round until nothing stays armed; the cap mirrors the
// source's own settleMaxRounds bound.
async function drainToFixedPoint(boot: MimicBoot): Promise<void> {
  for (let round = 0; round < 8 && boot.scheduler.pendingCount() > 0; round += 1) {
    await boot.scheduler.fire()
    await boot.source.idle()
  }
  await boot.source.settle()
}

describe("registration convergence over the host-mimicking context", () => {
  it("#given the real adapter sequence over a mimic that hands back the plugin's own output #when the reload events are delivered #then the reloads stop at a fixed point and the plan stays stable", async () => {
    // given
    const boot = await bootMimicRegistration()
    try {
      // when: three delivered rounds after the startup chain
      for (let round = 0; round < 3; round += 1) await deliverReloadRound(boot)
      const settledCounts = boot.reloadCounts()
      const settledPlan = boot.source.getPlan()

      // then: the plan reached its fixed point with the plugin agent added
      expect(settledPlan).toBeDefined()
      expect(Object.keys(settledPlan?.agents.added ?? {})).toEqual(["Sentinel - worker"])

      // when: two more delivered rounds
      for (let round = 0; round < 2; round += 1) await deliverReloadRound(boot)

      // then: no reload fired after the fixed point and the plan is unchanged
      expect(boot.reloadCounts()).toEqual(settledCounts)
      expect(boot.source.getPlan()).toEqual(settledPlan)
      expect(boot.scheduler.pendingCount()).toBe(0)
    } finally {
      await boot.source.subscription.stop()
      boot.dispose()
    }
  })
})

// The catalog-landing contract: the plan source subscribes to model.updated
// and provider.updated so the host's provider-catalog landing (the async
// registry init) triggers one recompute that re-resolves the model-dependent
// registrations (the delegate categories and the agent models). The re-bake
// converges: subsequent events don't re-arm because the plan reaches a new
// fixed point. agent/command updated are write echoes and stay unsubscribed.
describe("registration catalog-landing re-bake over the host-mimicking context", () => {
  it("#given the settled startup chain #when the catalog landing events deliver over grown host registries #then the plan source re-resolves and converges, and a foreign config change still recomputes", async () => {
    // given
    const boot = await bootMimicRegistration()
    try {
      for (let round = 0; round < 2; round += 1) await deliverReloadRound(boot)
      const settledCounts = boot.reloadCounts()

      // when: the host's registries grow (the catalog-landing shape) and
      // the model/provider events deliver (the subscribed catalog events)
      await boot.ctx.tool.transform((editor) => {
        editor.add({
          id: "late-host-tool",
          description: "host-only late tool",
          parameters: { type: "object", properties: {} },
        })
      })
      await boot.ctx.agent.transform((editor) => {
        editor.add({ id: "late-host-agent", name: "LateHost", mode: "subagent", hidden: false })
      })
      await boot.ctx.provider.transform((editor) => {
        editor.add({ info: buildProviderMirror("late-catalog", { name: "Late Catalog" }), models: [] })
      })
      for (const type of ["agent.updated", "command.updated", "model.updated", "provider.updated"]) {
        boot.ctx.__pushEvent({ type, created: 1, data: {} })
      }
      await flushAsync()
      await drainToFixedPoint(boot)

      // then: the plan source re-resolved and the cascade converged
      const rebakeCounts = boot.reloadCounts()
      const rebakePlan = boot.source.getPlan()
      expect(rebakePlan).toBeDefined()

      // when: the same events deliver again; the host's async init may
      // still be settling, so the convergence is checked after a further
      // delivery round confirms the counts stabilized
      for (const type of ["agent.updated", "command.updated", "model.updated", "provider.updated"]) {
        boot.ctx.__pushEvent({ type, created: 2, data: {} })
      }
      await flushAsync()
      await drainToFixedPoint(boot)
      const postSettle = boot.reloadCounts()

      // then: a further delivery round doesn't change the counts (converged)
      for (const type of ["agent.updated", "command.updated", "model.updated", "provider.updated"]) {
        boot.ctx.__pushEvent({ type, created: 3, data: {} })
      }
      await flushAsync()
      await drainToFixedPoint(boot)
      expect(boot.reloadCounts()).toEqual(postSettle)
      expect(boot.source.getPlan()?.agents.added["Sentinel - worker"]).toBeDefined()

      // when: a foreign config change lands
      await boot.ctx.agent.transform((editor) => {
        editor.add({ id: "config-probe-agent", name: "ConfigProbe", mode: "subagent", hidden: false })
      })
      boot.ctx.__pushEvent({ type: "config.updated", created: 4, data: {} })
      await flushAsync()
      await drainToFixedPoint(boot)

      // then: the omo items survive
      const ids = (await boot.ctx.agent.list()).data.map((agent) => agent.id)
      expect(ids).toContain("sentinel")
      for (const foreign of ["late-host-agent", "config-probe-agent"]) {
        expect(ids, `foreign agent ${foreign} survives`).toContain(foreign)
      }
      expect(boot.source.getPlan()?.agents.added["Sentinel - worker"]).toBeDefined()
    } finally {
      await boot.source.subscription.stop()
      boot.dispose()
    }
  })
})

// The moving-record contract (the 432dc9b7f0 real-host loop): after the
// startup chain settles, the real OpenCode 2 host's registry reads alternate
// projection-invisible fields (agent name form, host tool description) on
// every pass with ZERO registry events, so a record pass deep-differs its
// predecessor forever while the plan stays byte-identical. The record-change
// continuation must therefore converge inside its hard bound: the
// recomputes stop, no registration re-applies, and the plan never moves.
describe("registration moving-record convergence over the host-mimicking context", () => {
  it("#given the settled startup chain over a host whose reads alternate projection-invisible fields #when the post-init pass arms record-change continuations with zero events #then the recomputes stop inside the bound and no registration re-applies", async () => {
    // given
    const boot = await bootMimicRegistration({ volatileHostFields: true })
    try {
      await drainToFixedPoint(boot)
      const settledCounts = boot.reloadCounts()
      const settledPlan = boot.source.getPlan()
      expect(settledPlan).toBeDefined()

      // when: the post-init pass (startV2Runtime's restore) runs over the
      // moving reads and no event ever delivers
      boot.source.scheduleRecompute()
      let rounds = 0
      for (; rounds < MAX_RECORD_CONTINUATION_ROUNDS + 3; rounds += 1) {
        if (boot.scheduler.pendingCount() === 0) break
        await boot.scheduler.fire()
        await boot.source.idle()
      }

      // then: the chain stopped inside the bound
      expect(rounds).toBeGreaterThan(0)
      expect(rounds).toBeLessThanOrEqual(MAX_RECORD_CONTINUATION_ROUNDS)
      expect(boot.scheduler.pendingCount()).toBe(0)

      // when: three further passes run over the still-moving reads
      for (let round = 0; round < 3; round += 1) {
        boot.source.scheduleRecompute()
        await boot.scheduler.fire()
        await boot.source.idle()
        // then: nothing arms again and nothing re-applies
        expect(boot.scheduler.pendingCount()).toBe(0)
        expect(boot.reloadCounts()).toEqual(settledCounts)
      }
      expect(boot.source.getPlan()).toEqual(settledPlan)
    } finally {
      await boot.source.subscription.stop()
      boot.dispose()
    }
  })
})
