import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFakeV2Context, type FakeV2Context } from "../parity/fake-v2-context"
import { createAgentOverride, createToolOverride, type DomainHooks } from "../parity/plan-convergence-host-fake"
import { createCommandOverride, createMcpOverride } from "../parity/plan-convergence-host-fake-domains"
import { createProviderModelOverrides, seedHostModels } from "../parity/plan-convergence-host-fake-provider"
import { registerAgentTransform } from "./agents"
import type { AgentReplayContext } from "./agent-replay-types"
import { registerCommandTransform } from "./commands"
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
      config.provider = {
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
  readonly reloadCounts: () => { agent: number; tool: number; mcp: number; command: number }
  readonly dispose: () => void
}

// The real adapter sequence (runtime/adapters.ts order) over the mimic ctx:
// plan source, provider-model, todo, tool, agent, permission, mcp, command.
async function bootMimicRegistration(): Promise<MimicBoot> {
  const fake = createFakeV2Context()
  const agent = createAgentOverride(HOST_SEED_AGENTS)
  const tool = createToolOverride(HOST_SEED_TOOLS)
  const mcp = createMcpOverride()
  const command = createCommandOverride([
    { name: "help", execute: async () => undefined },
    { name: "review", execute: async () => undefined },
  ])
  const providerModel = createProviderModelOverrides(seedHostModels())
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
