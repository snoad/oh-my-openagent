import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  bootMimicRegistration,
  deliverReloadRound,
  drainToFixedPoint,
  flushAsync,
  type MimicBoot,
} from "./plan-convergence-boot"
import { buildProviderMirror } from "./provider-model-contributions"
import { MAX_RECONCILE_CONTINUATION_ROUNDS } from "./plan-source-continuation"
import { _flushForTesting, _resetLoggerForTesting, _setLoggerForTesting } from "../../shared/logger"

// The convergence contract on a host-mimicking context (the wave-3 reload
// loop): after the startup chain applies, delivering the reload events the
// reloads publish must stop producing reloads. The mimic hands every
// transform registration the live editor (containing this runtime's previous
// output, under the display-key ids the real host persists) and every reload
// the rebuilt view (canonical ids), the two forms the live capture proved.

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

// The post-settle reconciliation contract (the 432dc9b7f0 real-host loop):
// after the startup chain settles, the real OpenCode 2 host's registry reads
// alternate projection-invisible fields on every pass with ZERO events, and
// its async tool-registry init can wipe the plugin's own registrations. A
// continuation is armed only for a change that needs a reconciliation pass:
// a projected-base movement or lost own output. A steady host converges with
// no bound line; a pathological host stops at the bound with one log line.

const BOUND_LOG_MARKER = "stopping the recompute continuation"

function capturePluginLog(): { readonly file: string; readonly restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "oqa-conv-log-"))
  const file = join(dir, "log")
  _setLoggerForTesting({ filePath: file })
  return {
    file,
    restore: () => {
      _resetLoggerForTesting()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function boundLinesOf(file: string): number {
  _flushForTesting()
  return readFileSync(file, "utf8").split(BOUND_LOG_MARKER).length - 1
}

// One fired window is one recompute; the chain is quiet when nothing stays armed.
async function driveUntilQuiet(boot: MimicBoot, cap: number): Promise<number> {
  let rounds = 0
  for (; rounds < cap; rounds += 1) {
    if (boot.scheduler.pendingCount() === 0) break
    await boot.scheduler.fire()
    await boot.source.idle()
  }
  return rounds
}

describe("registration moving-record convergence over the host-mimicking context", () => {
  it("#given the settled startup chain over a host whose reads alternate projection-invisible fields #when the post-init pass runs with zero events #then exactly one recompute runs, nothing arms, and no bound line logs", async () => {
    // given
    const boot = await bootMimicRegistration({ volatileHostFields: true })
    const captured = capturePluginLog()
    try {
      await drainToFixedPoint(boot)
      const settledCounts = boot.reloadCounts()
      const settledPlan = boot.source.getPlan()
      expect(settledPlan).toBeDefined()

      // when: the post-init pass (startV2Runtime's restore) runs over the
      // moving reads and no event ever delivers
      boot.source.scheduleRecompute()
      const rounds = await driveUntilQuiet(boot, 6)

      // then: the post-init pass reconciles nothing - the volatile fields
      // are projection-invisible - so exactly one recompute ran and quieted
      expect(rounds).toBe(1)
      expect(boot.scheduler.pendingCount()).toBe(0)
      expect(boundLinesOf(captured.file)).toBe(0)

      // when: two further passes run over the still-moving reads
      for (let round = 0; round < 2; round += 1) {
        boot.source.scheduleRecompute()
        await boot.scheduler.fire()
        await boot.source.idle()
        // then: nothing arms and nothing re-applies
        expect(boot.scheduler.pendingCount()).toBe(0)
        expect(boot.reloadCounts()).toEqual(settledCounts)
      }
      expect(boot.source.getPlan()).toEqual(settledPlan)
    } finally {
      await boot.source.subscription.stop()
      captured.restore()
      boot.dispose()
    }
  })

  it("#given the settled startup chain #when the host wipes the plugin's own tools #then one detection pass and one restore pass run, the tools are present again, and the chain goes quiet", async () => {
    // given
    const boot = await bootMimicRegistration()
    const captured = capturePluginLog()
    try {
      await drainToFixedPoint(boot)
      const settledCounts = boot.reloadCounts()

      // when: the host's async tool-registry init drops every own tool.
      // The fake's transform registrations replay on every domain reload,
      // so the wipe is one-shot: a persistent callback would re-remove the
      // tools on every rebuild - a re-wiping host, not the observed single
      // async init wipe.
      let wiped = false
      await boot.ctx.tool.transform((editor) => {
        if (wiped) return
        wiped = true
        editor.remove("omo-grep")
        editor.remove("todowrite")
        editor.remove("todoread")
      })
      const wipedIds = (await boot.ctx.tool.list()).map((tool) => tool.id)
      expect(wipedIds).not.toContain("omo-grep")

      // when: one pass runs over the wiped editor (the post-init restore
      // pass, or any later config event's pass)
      boot.source.scheduleRecompute()
      const rounds = await driveUntilQuiet(boot, 6)

      // then: exactly the two predicted passes ran - the detection pass
      // reported the loss and armed, the restore pass re-applied and
      // reloaded the tools domain once
      expect(rounds).toBe(2)
      expect(boot.scheduler.pendingCount()).toBe(0)
      const restoredIds = (await boot.ctx.tool.list()).map((tool) => tool.id)
      for (const own of ["omo-grep", "todowrite", "todoread"]) {
        expect(restoredIds, `own tool ${own} restored`).toContain(own)
      }
      expect(boot.reloadCounts().tool).toBe(settledCounts.tool + 1)

      // when: two further passes run over the settled editor
      for (let round = 0; round < 2; round += 1) {
        boot.source.scheduleRecompute()
        await boot.scheduler.fire()
        await boot.source.idle()
        expect(boot.scheduler.pendingCount()).toBe(0)
        expect(boot.reloadCounts().tool).toBe(settledCounts.tool + 1)
      }
      expect(boundLinesOf(captured.file)).toBe(0)
    } finally {
      await boot.source.subscription.stop()
      captured.restore()
      boot.dispose()
    }
  })

  it("#given the settled startup chain #when a foreign host tool appears with zero events #then one continuation applies it into the plan and the chain goes quiet", async () => {
    // given
    const boot = await bootMimicRegistration()
    const captured = capturePluginLog()
    try {
      await drainToFixedPoint(boot)
      const settledCounts = boot.reloadCounts()

      // when: the host's tool registry grows (an MCP-server-connect shape)
      // and one pass observes it
      await boot.ctx.tool.transform((editor) => {
        editor.add({
          id: "late-host-tool",
          description: "host-only late tool",
          parameters: { type: "object", properties: {} },
        })
      })
      boot.source.scheduleRecompute()
      const rounds = await driveUntilQuiet(boot, 6)

      // then: the detection pass armed one continuation, whose pass applied
      // the moved plan and reloaded the tools domain once
      expect(rounds).toBe(2)
      expect(boot.scheduler.pendingCount()).toBe(0)
      expect(Object.keys(boot.source.getPlan()?.tools ?? {})).toContain("late-host-tool")
      expect(boot.reloadCounts().tool).toBe(settledCounts.tool + 1)
      const ids = (await boot.ctx.tool.list()).map((tool) => tool.id)
      expect(ids).toContain("late-host-tool")
      expect(ids).toContain("omo-grep")
      expect(boundLinesOf(captured.file)).toBe(0)
    } finally {
      await boot.source.subscription.stop()
      captured.restore()
      boot.dispose()
    }
  })

  it("#given a pathological host whose projected base moves on every pass #when the reconciliation chain runs #then it stops at the bound with exactly one log line", async () => {
    // given
    const boot = await bootMimicRegistration({ volatileHostIds: true })
    const captured = capturePluginLog()
    try {
      await drainToFixedPoint(boot)

      // when: post-settle passes keep seeing a moved projected base
      boot.source.scheduleRecompute()
      const rounds = await driveUntilQuiet(boot, MAX_RECONCILE_CONTINUATION_ROUNDS + 4)

      // then: the chain stopped at the bound with one stop line, and
      // nothing arms afterwards
      expect(rounds).toBe(MAX_RECONCILE_CONTINUATION_ROUNDS)
      expect(boot.scheduler.pendingCount()).toBe(0)
      expect(boundLinesOf(captured.file)).toBe(1)
      for (let round = 0; round < 2; round += 1) {
        boot.source.scheduleRecompute()
        await boot.scheduler.fire()
        await boot.source.idle()
        expect(boot.scheduler.pendingCount()).toBe(0)
      }
      expect(boundLinesOf(captured.file)).toBe(1)
    } finally {
      await boot.source.subscription.stop()
      captured.restore()
      boot.dispose()
    }
  })
})
