import { describe, expect, it } from "bun:test"

import { jsonDeepEqual } from "./plan-diff"
import { computeRegistrationPlan } from "./project-config"
import { EMPTY_PLAN, type RegistrationPlan } from "./registration-plan"
import type { V1ConfigProjection } from "./v1-config-projection"

function makeBase(): V1ConfigProjection {
  return {
    agent: {
      explore: { name: "explore", prompt: "explore prompt", mode: "subagent", tools: { write: false } },
    },
    tools: { bash: true, task: false },
    permission: { bash: "allow", task: "deny" },
    mcp: { websearch: { type: "remote", url: "https://mcp.example/mcp" } },
    command: { greet: { template: "hi $ARGUMENTS", description: "greet" } },
    provider: { anthropic: { options: { baseURL: "https://api.example" } } },
    unmapped: ["read"],
  }
}

function mutatingStubConfig(config: V1ConfigProjection): void {
  config.agent["sisyphus"] = { name: "sisyphus", prompt: "ultrawork prompt", mode: "primary" }
  config.agent["explore"] = { ...config.agent["explore"], prompt: "rewritten explore prompt" }
  delete config.command["greet"]
  config.mcp["lsp"] = { type: "local", command: ["bun", "run", "lsp"] }
  config.tools["grep_app_*"] = false
  config.model = "anthropic/claude-sonnet-5"
}

describe("computeRegistrationPlan", () => {
  it("#given a stub pipeline that adds, modifies and removes entries #when the plan computes #then each section carries the exact added, modified and removed sets", async () => {
    // given
    const base = makeBase()

    // when
    const plan = await computeRegistrationPlan({ base, pluginHooks: { config: mutatingStubConfig } })

    // then
    expect(Object.keys(plan.agents.added)).toEqual(["sisyphus"])
    expect(Object.keys(plan.agents.modified)).toEqual(["explore"])
    expect(plan.agents.removed).toEqual([])
    expect(plan.mcp.added["lsp"]).toEqual({ type: "local", command: ["bun", "run", "lsp"] })
    expect(plan.mcp.modified).toEqual({})
    expect(plan.mcp.removed).toEqual([])
    expect(plan.commands.removed).toEqual(["greet"])
    expect(plan.commands.added).toEqual({})
    expect(plan.tools["grep_app_*"]).toBe(false)
    expect(plan.model).toBe("anthropic/claude-sonnet-5")
    expect(plan.defaultAgent).toBeUndefined()
  })

  it("#given a stub pipeline #when two runs start from the same base #then both plans are equal", async () => {
    // given
    const base = makeBase()
    const first = await computeRegistrationPlan({ base, pluginHooks: { config: mutatingStubConfig } })

    // when
    const second = await computeRegistrationPlan({ base, pluginHooks: { config: mutatingStubConfig } })

    // then
    expect(jsonDeepEqual(first, second)).toBe(true)
    expect(second).toEqual(first)
  })

  it("#given a stub pipeline #when the plan computes #then the base is never mutated and the handler saw a clone without unmapped", async () => {
    // given
    const base = makeBase()
    const baseClone = structuredClone(base)
    const receivedConfigs: unknown[] = []

    // when
    await computeRegistrationPlan({
      base,
      pluginHooks: {
        config: async (config) => {
          receivedConfigs.push(config)
          mutatingStubConfig(config)
        },
      },
    })

    // then
    expect(receivedConfigs).toHaveLength(1)
    const received = receivedConfigs[0] as V1ConfigProjection
    expect(received === base).toBe(false)
    expect(Object.hasOwn(received, "unmapped")).toBe(false)
    expect(jsonDeepEqual(base, baseClone)).toBe(true)
    expect(Object.hasOwn(base, "sisyphus")).toBe(false)
  })

  it("#given a stub pipeline that sets default_agent #when the plan computes #then defaultAgent appears only when it changed", async () => {
    // given
    const base = makeBase()
    const changed: V1ConfigProjection = structuredClone(base)
    changed.default_agent = "sisyphus"

    // when
    const plan = await computeRegistrationPlan({
      base,
      pluginHooks: {
        config: async (config) => {
          config.default_agent = "sisyphus"
        },
      },
    })

    // then
    expect(plan.defaultAgent).toBe("sisyphus")
    const unchanged = await computeRegistrationPlan({ base: changed, pluginHooks: { config: async () => {} } })
    expect(unchanged.defaultAgent).toBeUndefined()
  })

  it("#given a rejecting stub pipeline #when the plan computes #then the rejection carries the handler error", async () => {
    // given
    const failure = new Error("pipeline exploded")

    // when
    const run = computeRegistrationPlan({
      base: makeBase(),
      pluginHooks: { config: async () => Promise.reject(failure) },
    })

    // then
    await expect(run).rejects.toBe(failure)
  })

  it("#given the empty plan #when a computed plan is compared against it #then a non-empty plan differs per section", () => {
    // given
    const empty = EMPTY_PLAN

    // when
    const plan: RegistrationPlan = {
      ...empty,
      agents: { added: { sisyphus: { prompt: "p", mode: "primary" } }, modified: {}, removed: [] },
    }

    // then
    expect(jsonDeepEqual(empty, plan)).toBe(false)
    expect(jsonDeepEqual(empty, EMPTY_PLAN)).toBe(true)
  })
})
