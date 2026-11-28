// The host-mimicking registration boot (shared harness for the convergence
// test files). The mimic hands every transform registration the live editor
// (containing this runtime's previous output, under the display-key ids the
// real host persists) and every reload the rebuilt view (canonical ids), the
// two forms the live capture proved.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFakeV2Context, type FakeV2Context } from "../parity/fake-v2-context"
import { createAgentOverride, createToolOverride } from "../parity/plan-convergence-host-fake"
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
      config.agent["Sentinel - worker"] = { prompt: "p", mode: "primary", permission: {} }
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

export async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

export type MimicBoot = {
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
// the plan stays byte-identical. volatileHostIds instead alternates a host
// tool's ID, which the projection keeps - the pathological-host shape the
// reconciliation bound exists for.
export async function bootMimicRegistration(options?: {
  readonly volatileHostFields?: boolean
  readonly volatileHostIds?: boolean
}): Promise<MimicBoot> {
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
    { planSource: source, tool: ctx.tool } as unknown as ToolRegistrationContext,
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

export async function deliverReloadRound(boot: MimicBoot): Promise<void> {
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
export async function drainToFixedPoint(boot: MimicBoot): Promise<void> {
  for (let round = 0; round < 8 && boot.scheduler.pendingCount() > 0; round += 1) {
    await boot.scheduler.fire()
    await boot.source.idle()
  }
  await boot.source.settle()
}
