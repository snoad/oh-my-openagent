import { describe, expect, it } from "bun:test"

import { releaseAllPromptAsyncReservationsForTesting } from "@oh-my-opencode/utils/prompt-async-gate"

import { validatePluginConfig } from "../../config/validate"
import { createFakeV2Context, type FakeV2Context } from "../parity/fake-v2-context"
import { createFakeV2SideEffects } from "../parity/fake-v2-side-effects"
import { startV2Runtime, type V2Runtime } from "../runtime/start-v2-runtime"
import { activeV2Runtimes, resetV2ProcessStateForTesting } from "../runtime/v2-runtime-deps"
import type { V2RuntimeDeps } from "../runtime/start-v2-runtime"
import { registerAgentTransform } from "./agents"
import type { AgentReplayEditor } from "./agent-replay-types"
import { createHostStateSnapshot } from "./host-state-snapshot"
import type { HostStateSnapshot } from "./host-state-snapshot"
import { EMPTY_PLAN, type RegistrationPlan } from "./registration-plan"

const ATLAS_MODEL_FIX = "anthropic/claude-sonnet-5"
const CANONICAL_ORDER = [
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

type Booted = {
  readonly ctx: FakeV2Context
  readonly runtime: V2Runtime
  readonly plan: RegistrationPlan
  readonly snapshot: HostStateSnapshot
}

async function bootRegistered(): Promise<Booted> {
  resetV2ProcessStateForTesting()
  releaseAllPromptAsyncReservationsForTesting()
  const ctx = createFakeV2Context()
  const deps: V2RuntimeDeps = {
    sideEffects: createFakeV2SideEffects(),
    engineDeps: {
      loadConfigChain: (directory, environment) => {
        const validation = validatePluginConfig(directory, environment)
        return {
          ...validation,
          config: {
            ...validation.config,
            agents: { ...validation.config.agents, atlas: { model: ATLAS_MODEL_FIX } },
          },
        }
      },
    },
  }
  const runtime = await startV2Runtime(ctx, deps)
  const plan = runtime.planSource?.getPlan()
  const snapshot = runtime.planSource?.snapshot
  if (plan === undefined || snapshot === undefined) throw new Error("the plan source is missing after boot")
  return { ctx, runtime, plan, snapshot }
}

async function listIds(ctx: FakeV2Context): Promise<string[]> {
  return (await ctx.agent.list()).data.map((agent) => agent.id)
}

async function editorDefault(ctx: FakeV2Context): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    void ctx.agent.transform((editor: AgentReplayEditor) => resolve(editor.defaultAgent?.()))
  })
}

function canonical(key: string): string {
  return (key.split(" - ")[0] ?? key).toLowerCase()
}

describe("agent registration over the real engine", () => {
  it("#given the hermetic ctx #when the runtime boots #then the agent list carries every plan agent exactly once in canonical order with the mapped fields", async () => {
    // given
    const booted = await bootRegistered()
    try {
      // when
      const list = (await booted.ctx.agent.list()).data

      // then
      const ids = list.map((agent) => agent.id)
      const planIds = [...Object.keys(booted.plan.agents.added), ...Object.keys(booted.plan.agents.modified)]
      const uniquePlanIds = [...new Set(planIds.map(canonical))]
      for (const id of uniquePlanIds) expect(ids, `registered agent ${id}`).toContain(id)
      expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
      const registeredOmo = ids.filter((id) => (CANONICAL_ORDER as readonly string[]).includes(id))
      expect(registeredOmo).toEqual([...CANONICAL_ORDER])
      const sisyphus = list.find((agent) => agent.id === "sisyphus")
      const sisyphusKey = Object.keys(booted.plan.agents.added).find((key) => key.startsWith("Sisyphus"))
      const sisyphusEntry = sisyphusKey === undefined ? undefined : booted.plan.agents.added[sisyphusKey]
      expect(sisyphus?.mode).toBe("primary")
      expect(sisyphus?.hidden).toBe(false)
      expect(sisyphus?.name).toBe(sisyphusKey)
      expect(sisyphus?.system).toBe(sisyphusEntry?.prompt)
      expect(sisyphus?.permissions?.length ?? 0).toBeGreaterThan(0)
      const rules = sisyphus?.permissions ?? []
      const last = rules.at(-1)
      expect(last, "the V1 default-allow fallback closes the ruleset").toEqual({
        action: "*",
        resource: "*",
        effect: "allow",
      })
      expect(rules.slice(0, -1).some((rule) => rule.effect === "deny" || rule.effect === "allow")).toBe(true)
    } finally {
      await booted.runtime.stop()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  it("#given an unchanged host agent with a V2 display name #when the plan is built and replayed #then the name lands as the V1 key and the other fields stay host-owned", async () => {
    // given
    const booted = await bootRegistered()
    try {
      const compactionKey = Object.keys(booted.plan.agents.modified).find((key) => canonical(key) === "compaction")
      expect(compactionKey, "the compaction agent carries a plan entry").toBeDefined()

      // when
      const list = (await booted.ctx.agent.list()).data
      const compaction = list.find((agent) => agent.id === "compaction")

      // then: the name is the V1 key and the host-owned fields survive untouched
      expect(compaction?.name).toBe("compaction")
      expect(compaction?.mode).toBe("primary")
      expect(compaction?.hidden).toBe(true)
    } finally {
      await booted.runtime.stop()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  it("#given a booted runtime #when the plan source recomputes again #then the registry keeps one entry per id with identical shape and the applied default is the plan default", async () => {
    // given
    const booted = await bootRegistered()
    try {
      const shape = (agents: ReadonlyArray<{ id: string; mode: string; hidden: boolean; name: string }>) =>
        JSON.stringify(agents.map((agent) => [agent.id, agent.mode, agent.hidden, agent.name]))
      const before = shape((await booted.ctx.agent.list()).data)

      // when
      await booted.runtime.planSource?.recompute()

      // then
      expect(shape((await booted.ctx.agent.list()).data)).toBe(before)
      expect(await editorDefault(booted.ctx)).toBe(canonical(booted.plan.defaultAgent ?? ""))
    } finally {
      await booted.runtime.stop()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  it("#given the plan and the registered editors #when compared #then every system prompt is byte-equal to the pipeline prompt and the built-in demotion matches the V1 output", async () => {
    // given
    const booted = await bootRegistered()
    try {
      const byId = new Map((await booted.ctx.agent.list()).data.map((agent) => [agent.id, agent]))

      // when: every plan agent entry against its registered item
      const entries = [...Object.entries(booted.plan.agents.added), ...Object.entries(booted.plan.agents.modified)]

      // then
      for (const [key, entry] of entries) {
        const item = byId.get(canonical(key))
        expect(item, `registered item for ${canonical(key)}`).toBeDefined()
        expect(item?.system, `system bytes of ${canonical(key)}`).toBe(entry.prompt)
      }
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
      await booted.runtime.stop()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  it("#given the recorded pre-transform base #when a reload-triggered recompute runs #then the base gains no omo id and the registry does not oscillate", async () => {
    // given
    const booted = await bootRegistered()
    try {
      const baseBefore = Object.keys((await booted.snapshot.get()).agent)
      expect(baseBefore).not.toContain("sisyphus")

      // when
      await booted.runtime.planSource?.recompute()

      // then
      const baseAfter = Object.keys((await booted.snapshot.get()).agent)
      expect(baseAfter.filter((id) => (CANONICAL_ORDER as readonly string[]).includes(id))).toEqual([])
      const ids = await listIds(booted.ctx)
      for (const omo of CANONICAL_ORDER) expect(ids, `omo agent ${omo} survives the recompute`).toContain(omo)
    } finally {
      await booted.runtime.stop()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  it("#given a foreign host agent appears between recomputes #when the recompute runs #then omo items survive, the foreign item is preserved and the base gains no omo id", async () => {
    // given
    const booted = await bootRegistered()
    try {
      // when
      await booted.ctx.agent.transform((editor) => {
        editor.add({ id: "oqa-foreign-agent", name: "Foreign", mode: "subagent", hidden: false })
      })
      await booted.runtime.planSource?.recompute()

      // then
      const ids = await listIds(booted.ctx)
      expect(ids).toContain("oqa-foreign-agent")
      for (const omo of CANONICAL_ORDER) expect(ids, `omo agent ${omo} survives the foreign change`).toContain(omo)
      const baseIds = Object.keys((await booted.snapshot.get()).agent)
      expect(baseIds).toContain("oqa-foreign-agent")
      expect(baseIds.filter((id) => (CANONICAL_ORDER as readonly string[]).includes(id))).toEqual([])
    } finally {
      await booted.runtime.stop()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  it("#given a hand plan against a host that already carries the ids #when the step replays #then an existing entry is updated in place and a removed entry disappears", async () => {
    // given: the host already carries probe-id with different fields
    const ctx = createFakeV2Context()
    await ctx.agent.transform((editor) => {
      editor.add({ id: "probe-id", name: "StaleName", mode: "subagent", hidden: false, system: "stale prompt" })
      editor.add({ id: "probe-gone", name: "GoneSoon", mode: "subagent", hidden: false })
    })
    const snapshot = createHostStateSnapshot(ctx)
    const plan: RegistrationPlan = {
      ...EMPTY_PLAN,
      agents: {
        added: { "probe-new": { prompt: "fresh prompt", mode: "subagent", name: "ProbeNew" } },
        modified: { "probe-id": { prompt: "rewritten prompt", mode: "primary", name: "ProbeId", hidden: false } },
        removed: ["probe-gone"],
      },
      defaultAgent: "probe-new",
    }
    const step = registerAgentTransform(ctx, () => plan, snapshot)
    await step.run({ ctx, engine: {}, snapshot, base: await snapshot.get(), plan })

    // when: the replay ran
    const list = (await ctx.agent.list()).data

    // then
    expect(list.filter((agent) => agent.id === "probe-id")).toHaveLength(1)
    const updated = list.find((agent) => agent.id === "probe-id")
    expect(updated?.system).toBe("rewritten prompt")
    expect(updated?.mode).toBe("primary")
    expect(list.map((agent) => agent.id)).not.toContain("probe-gone")
    expect(list.map((agent) => agent.id)).toContain("probe-new")
    expect(await editorDefault(ctx)).toBe("probe-new")
  })

  it("#given the suite #when a boot ran #then no runtime stays registered afterwards", async () => {
    // given
    const booted = await bootRegistered()
    await booted.runtime.stop()

    // then
    expect(activeV2Runtimes.size).toBe(0)
    releaseAllPromptAsyncReservationsForTesting()
  })
})
