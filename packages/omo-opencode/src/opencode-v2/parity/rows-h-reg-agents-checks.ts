import { expect } from "./bun-test-shim"

import { validatePluginConfig } from "../../config/validate"
import { createFakeV2Context, type FakeV2Context } from "./fake-v2-context"
import { createFakeV2SideEffects } from "./fake-v2-side-effects"
import { startV2Runtime } from "../runtime/start-v2-runtime"
import type { V2Runtime } from "../runtime/stop-v2-runtime"
import { resetV2ProcessStateForTesting } from "../runtime/v2-runtime-deps"
import type { AgentReplayEditor } from "../registration/agent-replay-types"
import type { RegistrationPlan } from "../registration/registration-plan"

// The check bodies of the wave-3 H-REG agent rows (plan task 24): every check
// boots the real engine over the fixture-backed fake ctx and drives the
// registered agent editor. rows-h-reg-agents.ts holds the row definitions.

const ATLAS_MODEL_FIX = "anthropic/claude-sonnet-5"
export const AGENT_CANONICAL_ORDER = [
  "sisyphus",
  "hephaestus",
  "prometheus",
  "atlas",
  "librarian",
  "metis",
  "momus",
  "multimodal-looker",
  "oracle",
  "sisyphus-junior",
] as const

type Booted = { readonly ctx: FakeV2Context; readonly runtime: V2Runtime; readonly plan: RegistrationPlan }

async function boot(): Promise<Booted> {
  resetV2ProcessStateForTesting()
  const ctx = createFakeV2Context()
  const runtime = await startV2Runtime(ctx, {
    sideEffects: createFakeV2SideEffects(),
    engineDeps: {
      loadConfigChain: (directory, environment) => {
        const validation = validatePluginConfig(directory, environment)
        return {
          ...validation,
          config: { ...validation.config, agents: { ...validation.config.agents, atlas: { model: ATLAS_MODEL_FIX } } },
        }
      },
    },
  })
  const plan = runtime.planSource?.getPlan()
  if (plan === undefined) throw new Error("the registration plan is missing after boot")
  return { ctx, runtime, plan }
}

async function stop(booted: Booted): Promise<void> {
  await booted.runtime.stop()
}

function canonical(key: string): string {
  return (key.split(" - ")[0] ?? key).toLowerCase()
}

function shapeOf(list: ReadonlyArray<{ id: string; mode: string; hidden: boolean; name: string }>): string {
  return JSON.stringify(list.map((agent) => [agent.id, agent.mode, agent.hidden, agent.name]))
}

export async function checkRegistration(): Promise<void> {
  const booted = await boot()
  try {
    const list = (await booted.ctx.agent.list()).data
    const ids = list.map((agent) => agent.id)
    const planIds = [...Object.keys(booted.plan.agents.added), ...Object.keys(booted.plan.agents.modified)]
    for (const id of [...new Set(planIds.map(canonical))]) expect(ids, `registered agent ${id}`).toContain(id)
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
    expect(ids.filter((id) => (AGENT_CANONICAL_ORDER as readonly string[]).includes(id))).toEqual([
      ...AGENT_CANONICAL_ORDER,
    ])
  } finally {
    await stop(booted)
  }
}

export async function checkReplayIdempotent(): Promise<void> {
  const booted = await boot()
  try {
    const before = shapeOf((await booted.ctx.agent.list()).data)
    await booted.runtime.planSource?.recompute()
    expect(shapeOf((await booted.ctx.agent.list()).data)).toBe(before)
  } finally {
    await stop(booted)
  }
}

export async function checkDefaultAgent(): Promise<void> {
  const booted = await boot()
  try {
    const applied = await new Promise<string | undefined>((resolve) => {
      void booted.ctx.agent.transform((editor: AgentReplayEditor) => resolve(editor.defaultAgent?.()))
    })
    expect(applied).toBe(canonical(booted.plan.defaultAgent ?? ""))
  } finally {
    await stop(booted)
  }
}

export async function checkBuiltinDemotion(): Promise<void> {
  const booted = await boot()
  try {
    const byId = new Map((await booted.ctx.agent.list()).data.map((agent) => [agent.id, agent]))
    expect(byId.get("build")?.mode).toBe("subagent")
    expect(byId.get("build")?.hidden).toBe(true)
    expect(byId.get("plan")?.mode).toBe("subagent")
    expect(byId.get("plan")?.hidden).toBe(true)
    expect(byId.get("compaction")?.hidden).toBe(true)
    expect(byId.get("title")?.hidden).toBe(true)
    expect(byId.get("summary")?.hidden).toBe(true)
    expect(byId.get("explore")?.hidden).toBe(false)
    expect(byId.get("general")?.hidden).toBe(false)
  } finally {
    await stop(booted)
  }
}

export async function checkPromptBytes(): Promise<void> {
  const booted = await boot()
  try {
    const byId = new Map((await booted.ctx.agent.list()).data.map((agent) => [agent.id, agent]))
    const entries = [...Object.entries(booted.plan.agents.added), ...Object.entries(booted.plan.agents.modified)]
    for (const [key, entry] of entries) {
      expect(byId.get(canonical(key))?.system, `system bytes of ${canonical(key)}`).toBe(entry.prompt)
    }
  } finally {
    await stop(booted)
  }
}

export async function checkSettleReload(): Promise<void> {
  const booted = await boot()
  try {
    const snapshot = booted.runtime.planSource?.snapshot
    if (snapshot === undefined) throw new Error("plan source snapshot missing")
    const baseBefore = Object.keys((await snapshot.get()).agent)
    expect(baseBefore).not.toContain("sisyphus")
    await booted.runtime.planSource?.recompute()
    const baseAfter = Object.keys((await snapshot.get()).agent)
    expect(baseAfter.filter((id) => (AGENT_CANONICAL_ORDER as readonly string[]).includes(id))).toEqual([])
    const ids = (await booted.ctx.agent.list()).data.map((agent) => agent.id)
    for (const omo of AGENT_CANONICAL_ORDER) expect(ids, `omo agent ${omo} survives the recompute`).toContain(omo)
  } finally {
    await stop(booted)
  }
}

export async function checkSettleForeign(): Promise<void> {
  const booted = await boot()
  try {
    await booted.ctx.agent.transform((editor) => {
      editor.add({ id: "oqa-foreign-agent", name: "Foreign", mode: "subagent", hidden: false })
    })
    await booted.runtime.planSource?.recompute()
    const ids = (await booted.ctx.agent.list()).data.map((agent) => agent.id)
    expect(ids).toContain("oqa-foreign-agent")
    for (const omo of AGENT_CANONICAL_ORDER) expect(ids, `omo agent ${omo} survives the foreign change`).toContain(omo)
  } finally {
    await stop(booted)
  }
}
