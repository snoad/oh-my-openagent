import { describe, expect, it } from "bun:test"

import { createFakeV2Context, type FakeV2Context } from "../parity/fake-v2-context"
import { createPlanSource, DEFAULT_PLAN_DEBOUNCE_MS, PLAN_SOURCE_EVENT_TYPES } from "./plan-source"
import type { PlanSource } from "./plan-source"
import type { V1WorkingConfig } from "./v1-config-projection"

function callOps(ctx: FakeV2Context, op: string): number {
  return ctx.__calls.filter((call) => call.op === op).length
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function createManualScheduler() {
  const pending = new Set<{ run: () => void }>()
  return {
    setTimeout: (callback: () => void, ms: number) => {
      const timer = { run: callback }
      pending.add(timer)
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

function sentinelEngine() {
  return {
    config: async (config: V1WorkingConfig) => {
      config.agent["omo-sentinel"] = { name: "omo-sentinel", prompt: "sentinel prompt", mode: "primary" }
    },
  }
}

async function fireOneEvent(
  ctx: FakeV2Context,
  source: PlanSource,
  scheduler: ReturnType<typeof createManualScheduler>,
  type: string,
): Promise<void> {
  ctx.__pushEvent({ type, created: 1, data: {} })
  await flushAsync()
  await scheduler.fire()
  await source.idle()
}

describe("PLAN_SOURCE_EVENT_TYPES", () => {
  it("#given the pinned host schema #when the subscription types are listed #then the five schema-confirmed updated events are subscribed", () => {
    expect([...PLAN_SOURCE_EVENT_TYPES]).toEqual([
      "config.updated",
      "agent.updated",
      "command.updated",
      "model.updated",
      "provider.updated",
    ])
    expect(DEFAULT_PLAN_DEBOUNCE_MS).toBe(500)
  })
})

describe("createPlanSource", () => {
  it("#given a stub pipeline and an injected scheduler #when several events land inside one debounce window #then exactly one recompute runs, and an event after the window causes the next", async () => {
    // given
    const ctx = createFakeV2Context()
    const scheduler = createManualScheduler()
    const source = await createPlanSource(ctx, sentinelEngine(), { scheduler })
    let recomputeCount = 0
    source.registerStep({
      id: "count",
      domain: "tool",
      run: () => {
        recomputeCount += 1
      },
    })

    // when
    ctx.__pushEvent({ type: "agent.updated", created: 1, data: {} })
    ctx.__pushEvent({ type: "config.updated", created: 2, data: {} })
    ctx.__pushEvent({ type: "command.updated", created: 3, data: {} })
    await flushAsync()

    // then
    expect(scheduler.pendingCount()).toBe(1)
    await scheduler.fire()
    await source.idle()
    expect(recomputeCount).toBe(1)

    // when: an event after the window
    await fireOneEvent(ctx, source, scheduler, "model.updated")

    // then
    expect(recomputeCount).toBe(2)
    await source.subscription.stop()
  })

  it("#given a stub pipeline that registers one new agent #when the initial recompute lands #then only the changed domain reloads, and an unchanged recompute skips the reload", async () => {
    // given
    const ctx = createFakeV2Context()
    const scheduler = createManualScheduler()
    const source = await createPlanSource(ctx, sentinelEngine(), { scheduler })
    expect(callOps(ctx, "agent.reload")).toBe(1)
    expect(callOps(ctx, "tool.reload")).toBe(0)
    expect(Object.keys(source.getPlan()?.agents.added ?? {})).toEqual(["omo-sentinel"])

    // when: the same plan recomputes
    await fireOneEvent(ctx, source, scheduler, "agent.updated")

    // then
    expect(callOps(ctx, "agent.reload")).toBe(1)
    await source.subscription.stop()
  })

  it("#given the plugin's own registration recorded its pre-transform base #when the reload's own event retriggers the recompute #then the plan is unchanged, no second reload fires and the recorded base is not re-read", async () => {
    // given
    const ctx = createFakeV2Context()
    const scheduler = createManualScheduler()
    const source = await createPlanSource(ctx, sentinelEngine(), { scheduler })
    expect(callOps(ctx, "agent.list")).toBe(1)

    // when: the simulated task-24 registration records editor.list() before its own edit
    await ctx.agent.transform((editor) => {
      source.snapshot.record({ domain: "agent", value: { agents: editor.list() } })
      editor.add({ id: "omo-sentinel", name: "OmoSentinel", mode: "primary", hidden: false })
    })

    // then: the reload-triggered recompute reads the recorded base, yields the same plan and never reloads
    await fireOneEvent(ctx, source, scheduler, "agent.updated")
    expect(callOps(ctx, "agent.reload")).toBe(1)
    expect(callOps(ctx, "agent.list")).toBe(1)
    expect(Object.keys(source.getPlan()?.agents.added ?? {})).toEqual(["omo-sentinel"])
    await source.subscription.stop()
  })

  it("#given a foreign host agent registration without a record #when a host config change retriggers the recompute #then the base re-reads, the plan still carries the omo item and no reload oscillates", async () => {
    // given
    const ctx = createFakeV2Context()
    const scheduler = createManualScheduler()
    const source = await createPlanSource(ctx, sentinelEngine(), { scheduler })

    // when
    await ctx.agent.transform((editor) => {
      editor.add({ id: "user-custom", name: "UserCustom", mode: "subagent", hidden: false })
    })
    await fireOneEvent(ctx, source, scheduler, "config.updated")

    // then
    expect(callOps(ctx, "agent.list")).toBe(2)
    expect(Object.keys(source.getPlan()?.agents.added ?? {})).toEqual(["omo-sentinel"])
    expect(callOps(ctx, "agent.reload")).toBe(1)
    await source.subscription.stop()
  })

  it("#given tool and agent steps #when a recompute runs #then tool steps run before the config pipeline and agent steps after it", async () => {
    // given
    const ctx = createFakeV2Context()
    const scheduler = createManualScheduler()
    const source = await createPlanSource(ctx, sentinelEngine(), { scheduler })
    const planBeforeRecompute = source.getPlan()
    const seen: Array<{ readonly step: string; readonly plan: unknown }> = []
    source.registerStep({
      id: "order-tool",
      domain: "tool",
      run: (input) => {
        seen.push({ step: "tool", plan: input.plan })
      },
    })
    source.registerStep({
      id: "order-agent",
      domain: "agent",
      run: (input) => {
        seen.push({ step: "agent", plan: input.plan })
      },
    })

    // when
    await source.recompute()

    // then
    expect(seen.map((entry) => entry.step)).toEqual(["tool", "agent"])
    expect(seen[0]?.plan).toBe(planBeforeRecompute)
    expect(seen[1]?.plan).not.toBe(planBeforeRecompute)
    expect(seen[1]?.plan).toEqual(source.getPlan())
    await source.subscription.stop()
  })

  it("#given an engine without a config handler #when the plan source recomputes #then no plan applies and no domain reloads", async () => {
    // given
    const ctx = createFakeV2Context()
    const scheduler = createManualScheduler()
    const source = await createPlanSource(ctx, {}, { scheduler })

    // when
    await fireOneEvent(ctx, source, scheduler, "config.updated")

    // then
    expect(source.getPlan()).toBeUndefined()
    expect(callOps(ctx, "agent.reload")).toBe(0)
    await source.subscription.stop()
  })
})
