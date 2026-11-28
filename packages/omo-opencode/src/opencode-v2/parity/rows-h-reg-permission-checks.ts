import { expect } from "./bun-test-shim"

import { validatePluginConfig } from "../../config/validate"
import { createFakeV2Context, type FakeV2Context } from "./fake-v2-context"
import { createFakeV2SideEffects } from "./fake-v2-side-effects"
import { startV2Runtime } from "../runtime/start-v2-runtime"
import { resetV2ProcessStateForTesting } from "../runtime/v2-runtime-deps"
import { permissionStep, unmappedGlobPatternsOfPlan } from "../registration/permissions"
import type { RegistrationPlan } from "../registration/registration-plan"
import type { V2Runtime } from "../runtime/stop-v2-runtime"

// The check bodies of the wave-3 H-REG permission rows (plan task 27): the
// registered agent items carry the documented correspondence with the
// trailing wildcard allow, the every-agent global rules land on each omo
// agent, the unmappable glob patterns report once while the expressible rules
// still apply, and the hidden V1 tool entries are deleted from a request's
// tools through the registered context hook. rows-h-reg-permission.ts holds
// the row definitions.

type Booted = { readonly ctx: FakeV2Context; readonly runtime: V2Runtime; readonly plan: RegistrationPlan }

const ATLAS_MODEL_FIX = "anthropic/claude-sonnet-5"

type AgentRule = { readonly action: string; readonly resource: string; readonly effect: string }

type AgentItem = { readonly id: string; readonly permissions?: ReadonlyArray<AgentRule> }

async function boot(): Promise<Booted> {
  resetV2ProcessStateForTesting()
  const ctx = createFakeV2Context()
  const runtime = await startV2Runtime(ctx, {
    sideEffects: createFakeV2SideEffects(),
    engineDeps: {
      loadConfigChain: (directory, environment) => {
        const loaded = validatePluginConfig(directory, environment)
        return {
          ...loaded,
          config: { ...loaded.config, agents: { ...loaded.config.agents, atlas: { model: ATLAS_MODEL_FIX } } },
        }
      },
    },
  })
  const plan = runtime.planSource?.getPlan()
  if (plan === undefined) throw new Error("the registration plan is missing after boot")
  return { ctx, runtime, plan }
}

async function agentItems(ctx: FakeV2Context): Promise<ReadonlyArray<AgentItem>> {
  return (await ctx.agent.list()).data.map((agent) => ({
    id: agent.id,
    permissions: (agent.permissions ?? []).map((rule) => ({
      action: rule.action,
      resource: rule.resource,
      effect: rule.effect,
    })),
  }))
}

const RAW_V1_ACTIONS = new Set(["bash", "task", "write", "patch"])

export async function checkPermissionCorrespondence(): Promise<void> {
  const booted = await boot()
  try {
    const items = await agentItems(booted.ctx)
    const sisyphus = items.find((agent) => agent.id === "sisyphus")
    expect(sisyphus, "sisyphus is registered").toBeDefined()
    const rules = sisyphus?.permissions ?? []
    expect(rules.length, "the ruleset is not empty").toBeGreaterThan(0)
    expect(rules.at(-1), "the V1 default-allow fallback closes the ruleset").toEqual({
      action: "*",
      resource: "*",
      effect: "allow",
    })
    for (const rule of rules) {
      expect(RAW_V1_ACTIONS.has(rule.action), `action ${rule.action} is translated`).toBe(false)
    }
    expect(
      rules.some((rule) => rule.action === "shell"),
      "the bash rules govern shell",
    ).toBe(true)
    expect(
      rules.some((rule) => rule.action === "subagent"),
      "the task rules govern subagent",
    ).toBe(true)
  } finally {
    await booted.runtime.stop()
  }
}

export async function checkGlobalRulesOnEveryOmoAgent(): Promise<void> {
  const booted = await boot()
  try {
    const items = await agentItems(booted.ctx)
    const omoIds = ["sisyphus", "hephaestus", "prometheus", "atlas", "sisyphus-junior", "metis", "momus"]
    for (const id of omoIds) {
      const item = items.find((agent) => agent.id === id)
      expect(item, `omo agent ${id} is registered`).toBeDefined()
      expect(item?.permissions?.at(-1), `the wildcard allow closes ${id}'s ruleset`).toEqual({
        action: "*",
        resource: "*",
        effect: "allow",
      })
      expect(
        item?.permissions?.some((rule) => rule.action === "teammate"),
        `the every-agent teammate rule lands on ${id}`,
      ).toBe(true)
    }
    for (const id of ["build", "compaction"]) {
      const item = items.find((agent) => agent.id === id)
      expect(
        item?.permissions?.some((rule) => rule.action === "teammate" && rule.effect === "deny"),
        `the global teammate deny lands on the host agent ${id}`,
      ).toBe(true)
    }
  } finally {
    await booted.runtime.stop()
  }
}

export async function checkUnmappedReportedOnce(): Promise<void> {
  const booted = await boot()
  try {
    const plan = booted.plan
    const patterns = unmappedGlobPatternsOfPlan(plan)
    expect(patterns.length, "the plan carries glob tool rules").toBeGreaterThan(0)
    const reported: string[] = []
    const step = permissionStep({ onUnmapped: (pattern) => reported.push(pattern) })
    await step.run({ plan, apply: true } as Parameters<typeof step.run>[0])
    const firstRun = [...reported]
    expect(firstRun.sort()).toEqual([...patterns].sort())
    await step.run({ plan, apply: true } as Parameters<typeof step.run>[0])
    expect(reported, "each distinct pattern reports exactly once").toEqual(firstRun)
  } finally {
    await booted.runtime.stop()
  }
}

type ContextEvent = {
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly id: string; readonly providerID: string }
  system: Array<Record<string, unknown>>
  messages: Array<Record<string, unknown>>
  options: Record<string, unknown>
  tools: Record<string, { description: string; input: unknown }>
}

export async function checkHiddenToolRemovedFromRequest(): Promise<void> {
  const booted = await boot()
  try {
    const event: ContextEvent = {
      sessionID: "ses_perm",
      agent: "sisyphus",
      model: { id: "gpt-fake", providerID: "openai" },
      system: [],
      messages: [],
      options: {},
      tools: {
        grep: { description: "d", input: {} },
        grep_app_search: { description: "d", input: {} },
        task_create: { description: "d", input: {} },
        teammate: { description: "d", input: {} },
        skill: { description: "d", input: {} },
      },
    }
    await booted.ctx.__fire("session", "context", event as never)
    expect(Object.keys(event.tools).sort(), "the hidden V1 entries are gone, the exact tools stay").toEqual([
      "grep",
      "skill",
    ])
  } finally {
    await booted.runtime.stop()
  }
}
