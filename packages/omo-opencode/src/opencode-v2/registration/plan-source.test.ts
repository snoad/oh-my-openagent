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
  const state: { autoFire: boolean } = { autoFire: false }
  return {
    setTimeout: (callback: () => void, ms: number) => {
      const timer = { run: callback }
      pending.add(timer)
      if (state.autoFire) {
        queueMicrotask(() => {
          if (!pending.delete(timer)) return
          callback()
        })
      }
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
    state,
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
  it("#given the pinned host schema #when the subscription types are listed #then the config change and the catalog-landing events are subscribed", () => {
    expect([...PLAN_SOURCE_EVENT_TYPES]).toEqual(["config.updated", "model.updated", "provider.updated"])
    expect(DEFAULT_PLAN_DEBOUNCE_MS).toBe(500)
  })
})

describe("createPlanSource", () => {
  it("#given a stub pipeline and an injected scheduler #when several events land inside one debounce window #then exactly one recompute runs, a non-config event arms nothing and a later config event causes the next", async () => {
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

    // when: a write echo after the window (agent.updated is not subscribed)
    await fireOneEvent(ctx, source, scheduler, "agent.updated")

    // then: nothing armed, nothing recomputed
    expect(recomputeCount).toBe(1)
    expect(scheduler.pendingCount()).toBe(0)

    // when: a host config change after the window
    await fireOneEvent(ctx, source, scheduler, "config.updated")

    // then
    expect(recomputeCount).toBe(2)
    await source.subscription.stop()
  })

  it("#given a stub pipeline that registers one new agent #when the initial recompute lands #then only the changed domain reloads, and a registry echo event recomputes nothing", async () => {
    // given
    const ctx = createFakeV2Context()
    const scheduler = createManualScheduler()
    const source = await createPlanSource(ctx, sentinelEngine(), { scheduler })
    expect(callOps(ctx, "agent.reload")).toBe(1)
    expect(callOps(ctx, "tool.reload")).toBe(0)
    expect(Object.keys(source.getPlan()?.agents.added ?? {})).toEqual(["omo-sentinel"])

    // when: the reload's own echo event delivers (the host republishes the
    // registration's mutations)
    await fireOneEvent(ctx, source, scheduler, "agent.updated")

    // then: no recompute armed, so no reload fired
    expect(callOps(ctx, "agent.reload")).toBe(1)
    expect(scheduler.pendingCount()).toBe(0)
    await source.subscription.stop()
  })

  it("#given the plugin's own registration recorded its pre-transform base #when the next config-change recompute lands #then the plan is unchanged, no second reload fires and the recorded base is not re-read", async () => {
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

    // then: the config-change recompute reads the recorded base, yields the
    // same plan and never reloads; its record pass is stable, so no
    // continuation follows it
    await fireOneEvent(ctx, source, scheduler, "config.updated")
    await scheduler.fire()
    await source.idle()
    expect(callOps(ctx, "agent.reload")).toBe(1)
    expect(callOps(ctx, "agent.list")).toBe(1)
    expect(Object.keys(source.getPlan()?.agents.added ?? {})).toEqual(["omo-sentinel"])
    expect(scheduler.pendingCount()).toBe(0)
    await source.subscription.stop()
  })

  it("#given a foreign host agent registration without a record #when a host config change retriggers the recompute #then the base re-reads, the plan still carries the omo item and no reload oscillates", async () => {
    // given
    const ctx = createFakeV2Context()
    const scheduler = createManualScheduler()
    const source = await createPlanSource(ctx, sentinelEngine(), { scheduler })

    // when
    await ctx.agent.transform((editor) => {
      editor.add({ id: "user-custom", name: "user-custom", mode: "subagent", hidden: false })
    })
    await fireOneEvent(ctx, source, scheduler, "config.updated")

    // then
    expect(callOps(ctx, "agent.list")).toBe(2)
    expect(Object.keys(source.getPlan()?.agents.added ?? {})).toEqual(["omo-sentinel"])
    // the name_only normalization entry for the new base-backed agent is a
    // real plan change, so it legitimately reloads the agent domain once
    expect(callOps(ctx, "agent.reload")).toBe(2)
    await source.subscription.stop()
  })

  it("#given a registered step for an unchanged plan #when the next recompute lands #then the step's domain reloads exactly once and never again", async () => {
    // given: the sentinel plan is already applied, so no further recompute reloads anything
    const ctx = createFakeV2Context()
    const scheduler = createManualScheduler()
    const source = await createPlanSource(ctx, sentinelEngine(), { scheduler })
    expect(callOps(ctx, "tool.reload")).toBe(0)

    // when: a tool-domain step registers after the initial apply (the task-25
    // adapter order: its editor transform only reaches the host on the reload)
    source.registerStep({
      id: "reload-tool",
      domain: "tool",
      run: () => undefined,
    })
    await source.recompute()

    // then: exactly one tool reload fired on that recompute despite the unchanged plan
    expect(callOps(ctx, "tool.reload")).toBe(1)

    // when: the same unchanged plan recomputes again
    await fireOneEvent(ctx, source, scheduler, "config.updated")

    // then: no further reload fires
    expect(callOps(ctx, "tool.reload")).toBe(1)
    await source.subscription.stop()
  })

  it("#given steps for tool and agent domains #when the first post-registration recompute lands #then each registered domain reloads once in one pass", async () => {
    // given
    const ctx = createFakeV2Context()
    const scheduler = createManualScheduler()
    const source = await createPlanSource(ctx, sentinelEngine(), { scheduler })

    // when
    source.registerStep({ id: "reload-tools", domain: "tool", run: () => undefined })
    source.registerStep({ id: "reload-agents", domain: "agent", run: () => undefined })
    await source.recompute()

    // then: each registered domain reloads once on that recompute; the agent
    // count adds the initial plan-diff reload from the sentinel engine
    expect(callOps(ctx, "tool.reload")).toBe(1)
    expect(callOps(ctx, "agent.reload")).toBe(2)
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

  it("#given a registration that lands mid-chain state the plan reads #when the runtime's active point drains via settle #then the settled plan is the one the first session observes and no debounce stays armed", async () => {
    // given: the pipeline mirrors the real V1 handler's dependence on host
    // state the registration steps land later: the late agent exists in the
    // plan only once the snapshot carries the late tool.
    const ctx = createFakeV2Context()
    const scheduler = createManualScheduler()
    const lateEngine = {
      config: async (config: V1WorkingConfig) => {
        config.agent["omo-sentinel"] = { name: "omo-sentinel", prompt: "sentinel prompt", mode: "primary" }
        if (config.tools["race-late-tool"] === true) {
          config.agent["race-late-agent"] = { name: "race-late-agent", prompt: "late", mode: "subagent" }
        }
      },
    }
    const source = await createPlanSource(ctx, lateEngine, { scheduler })

    // when: the runtime adapter order registers the tool step and recomputes;
    // the step's registration lands the tool on the host editor mid-recompute
    // (the snapshot refreshed before the step ran, the runtime's own order)
    source.registerStep({
      id: "race-tool",
      domain: "tool",
      run: async () => {
        await ctx.tool.transform((editor) => {
          editor.add({
            id: "race-late-tool",
            name: "race-late-tool",
            description: "lands after the refresh",
            input: { type: "object", properties: {} },
            execute: async () => ({ content: "ok" }),
          })
        })
      },
    })
    await source.recompute()

    // and when: a host config change lands exactly as the real driver's
    // L-03 rewrite does while the adapter chain is still settling, arming a
    // debounce that outlives the adapter chain
    ctx.__pushEvent({ type: "config.updated", created: 1, data: {} })
    await flushAsync()

    // then: the old active point reports the plugin with the plan NOT yet
    // settled (RED on the code without the drain: the first session reads it)
    expect(scheduler.pendingCount()).toBe(1)
    expect(source.getPlan()?.agents.added["race-late-agent"]).toBeUndefined()

    // when: the armed window elapses (the runtime's own debounce), then the
    // runtime drains to the fixed point before reporting active
    await scheduler.fire()
    await source.settle()

    // then: the armed chain drained, the late plan section landed and nothing
    // stays armed behind the plugin's active report
    expect(source.getPlan()?.agents.added["race-late-agent"]).toBeDefined()
    expect(scheduler.pendingCount()).toBe(0)
    await source.subscription.stop()
  })

  it("#given an idle plan source with no armed debounce #when settle runs #then it resolves immediately without recomputing or scheduling anything", async () => {
    // given
    const ctx = createFakeV2Context()
    const scheduler = createManualScheduler()
    const source = await createPlanSource(ctx, sentinelEngine(), { scheduler })
    expect(scheduler.pendingCount()).toBe(0)
    const planBeforeSettle = source.getPlan()

    // when
    await source.settle()

    // then: no injected recompute touched the plan, nothing stays scheduled
    expect(scheduler.pendingCount()).toBe(0)
    expect(source.getPlan()).toBe(planBeforeSettle)
    await source.subscription.stop()
  })

  it("#given an event storm that keeps re-arming the debounce #when settle hits the round cap #then it returns the drained-prefix state instead of hanging", async () => {
    // given: every fired window sees a fresh event (auto-fire resolves each
    // armed window as soon as it is scheduled, the storm re-arms immediately)
    const ctx = createFakeV2Context()
    const scheduler = createManualScheduler()
    scheduler.state.autoFire = true
    const source = await createPlanSource(ctx, sentinelEngine(), { scheduler, settleMaxRounds: 2 })

    // when
    ctx.__pushEvent({ type: "config.updated", created: 1, data: {} })
    await flushAsync()
    const draining = source.settle()
    for (let round = 0; round < 8; round += 1) {
      ctx.__pushEvent({ type: "config.updated", created: round, data: {} })
      await flushAsync()
    }
    await draining

    // then: settle returned under the storm (bounded), the plan is applied
    expect(source.getPlan()).toBeDefined()
    await source.subscription.stop()
  })
})
