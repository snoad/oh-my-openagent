import { expect } from "./bun-test-shim"

import { createFakeV2Context, type FakeV2Context } from "./fake-v2-context"
import { createCountingScheduler, createStubV2EngineFactory, runV2ReloadCycles } from "./fake-v2-engine"
import { createFakeV2SideEffects } from "./fake-v2-side-effects"
import { startV2Runtime } from "../runtime/start-v2-runtime"
import { activeV2Runtimes, resetV2ProcessStateForTesting, v2ProcessSnapshot, type V2ProcessDepName, type V2ProcessDepStatus } from "../runtime/v2-runtime-deps"
import { defineGroup, type ParityRow, type ParityRowGroupItem } from "./rows"

// Wave-1 H-RELOAD rows (plan task 13): the reload lifecycle of the OpenCode 2
// runtime. Two locations run two engines over the single process-wide
// dependencies, stopping one leaves the other live, N setup and cleanup cycles
// end with zero live dependencies and zero pending timers, subscriptions and
// registrations, a same-location reload stops the previous runtime first and
// a double cleanup disposes exactly once.

function fakeLocationContext(directory: string): FakeV2Context {
  return createFakeV2Context({
    location: { directory, project: { id: `prj_${directory.replaceAll("/", "_")}`, directory, canonical: directory } },
    scheduler: createCountingScheduler(),
  })
}

function snapshotOf(name: V2ProcessDepName): V2ProcessDepStatus {
  return v2ProcessSnapshot()[name]
}

function row(suffix: string, title: string, check: () => void | Promise<void>): ParityRowGroupItem {
  return { suffix, title, kind: "hermetic", is: ["IS-17"], wave: 1, status: "checked", check }
}

async function checkTwoLocationsShareSingletons(): Promise<void> {
  resetV2ProcessStateForTesting()
  const sideEffects = createFakeV2SideEffects({ openclaw: true })
  const ctxA = fakeLocationContext("/tmp/w1-hr-a")
  const ctxB = fakeLocationContext("/tmp/w1-hr-b")
  const engineA = createStubV2EngineFactory({ ctx: ctxA })
  const engineB = createStubV2EngineFactory({ ctx: ctxB })
  const runtimeA = await startV2Runtime(ctxA, { engineFactory: engineA.factory, sideEffects })
  await startV2Runtime(ctxB, { engineFactory: engineB.factory, sideEffects })
  expect(engineA.state.starts).toEqual(["/tmp/w1-hr-a"])
  expect(engineB.state.starts).toEqual(["/tmp/w1-hr-b"])
  for (const name of ["sweep", "openclaw", "skillSource", "telemetry"] as const) {
    expect(snapshotOf(name), `${name} while two runtimes are live`).toEqual({ live: 2, started: 1, maxConcurrent: 1 })
  }
  expect(sideEffects.tallies.migrationCwds).toEqual(["/tmp/w1-hr-a", "/tmp/w1-hr-b"])
  await runtimeA.stop()
  expect(engineA.state.disposes).toBe(1)
  expect(sideEffects.tallies.skillSourceStops, "skill source while engine B still runs").toBe(0)
  for (const name of ["sweep", "openclaw", "skillSource", "telemetry"] as const) {
    expect(snapshotOf(name), `${name} after one stop`).toEqual({ live: 1, started: 1, maxConcurrent: 1 })
  }
}

async function checkReloadCyclesEndClean(): Promise<void> {
  const sideEffects = createFakeV2SideEffects()
  const report = await runV2ReloadCycles({ cycles: 2, sideEffects })
  expect(report.engineStarts).toBe(2)
  expect(report.engineDisposes).toBe(2)
  expect(report.pendingTimers, "pending timers after the last cycle").toBe(0)
  expect(report.openSubscriptions, "open subscriptions after the last cycle").toBe(0)
  expect(report.openRegistrations, "open registrations after the last cycle").toBe(0)
  for (const name of ["sweep", "skillSource", "telemetry"] as const) {
    expect(report.snapshot[name], `${name} after the last cycle`).toEqual({ live: 0, started: 2, maxConcurrent: 0 })
  }
  expect(report.snapshot.openclaw, "openclaw never configured in the scenario").toEqual({ live: 0, started: 0, maxConcurrent: 0 })
  expect(sideEffects.tallies.migrationCwds, "migration once per location").toEqual(["/tmp/fake-v2"])
  expect(activeV2Runtimes.size).toBe(0)
}

async function checkSameLocationReloadStopsPrevious(): Promise<void> {
  resetV2ProcessStateForTesting()
  const sideEffects = createFakeV2SideEffects()
  const ctx = fakeLocationContext("/tmp/w1-hr-reload")
  const first = createStubV2EngineFactory({ ctx })
  const second = createStubV2EngineFactory({ ctx })
  await startV2Runtime(ctx, { engineFactory: first.factory, sideEffects })
  const runtime = await startV2Runtime(ctx, { engineFactory: second.factory, sideEffects })
  expect(first.state.disposes, "previous engine disposed by the reload").toBe(1)
  expect(second.state.starts).toEqual(["/tmp/w1-hr-reload"])
  expect(snapshotOf("sweep")).toEqual({ live: 1, started: 2, maxConcurrent: 1 })
  expect(activeV2Runtimes.get("/tmp/w1-hr-reload")).toBe(runtime)
  await runtime.stop()
}

async function checkDoubleCleanupDisposesOnce(): Promise<void> {
  resetV2ProcessStateForTesting()
  const sideEffects = createFakeV2SideEffects()
  const ctx = fakeLocationContext("/tmp/w1-hr-twice")
  const engine = createStubV2EngineFactory({ ctx })
  const runtime = await startV2Runtime(ctx, { engineFactory: engine.factory, sideEffects })
  await runtime.stop()
  await runtime.stop()
  expect(engine.state.disposes, "engine dispose calls").toBe(1)
  expect(sideEffects.tallies.skillSourceStops, "shared server stops").toBe(1)
  expect(activeV2Runtimes.size).toBe(0)
}

export const hReloadRows: ParityRow[] = defineGroup("H-RELOAD", [
  row("TWO-LOCATIONS", "two locations start two engines over the shared process-wide dependencies and stopping one keeps them live", checkTwoLocationsShareSingletons),
  row("CYCLES-END-CLEAN", "N setup and cleanup cycles end with zero live process-wide deps and zero pending timers, subscriptions and registrations", checkReloadCyclesEndClean),
  row("SAME-LOCATION-RELOAD", "a second setup for the same location stops the previous runtime first", checkSameLocationReloadStopsPrevious),
  row("DOUBLE-CLEANUP", "a cleanup called twice disposes the engine exactly once without error", checkDoubleCleanupDisposesOnce),
])
