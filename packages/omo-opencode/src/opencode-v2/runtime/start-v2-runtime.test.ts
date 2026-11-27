import { beforeEach, describe, expect, test } from "bun:test"

import type { FakeV2Context } from "../parity/fake-v2-context"
import { createFakeV2Context } from "../parity/fake-v2-context"
import {
  captureConsoleLines,
  createCountingScheduler,
  createStubV2EngineFactory,
  runV2ReloadCycles,
} from "../parity/fake-v2-engine"
import { createFakeV2SideEffects } from "../parity/fake-v2-side-effects"
import { startV2Runtime } from "./start-v2-runtime"
import {
  activeV2Runtimes,
  resetV2ProcessStateForTesting,
  v2ProcessSnapshot,
  type V2ProcessDepStatus,
} from "./v2-runtime-deps"

// startV2Runtime / stopV2Runtime lifecycle (plan task 13): one engine per
// location, the process-wide dependencies shared through the refcounted
// records, a host reload stopping the previous runtime first, and the
// auto-update reload cycle ending with zero live state.

function fakeLocationContext(directory: string, scheduler = createCountingScheduler()): FakeV2Context {
  return createFakeV2Context({
    location: { directory, project: { id: `prj_${directory.replaceAll("/", "_")}`, directory, canonical: directory } },
    scheduler,
  })
}

function snapshotOf(name: string): V2ProcessDepStatus {
  return v2ProcessSnapshot()[name]
}

beforeEach(() => {
  resetV2ProcessStateForTesting()
})

describe("startV2Runtime", () => {
  test("#given two locations #when both engines start #then the process-wide deps run once and the migration runs once per location", async () => {
    // given
    const sideEffects = createFakeV2SideEffects({ openclaw: true })
    const ctxA = fakeLocationContext("/tmp/w1-a")
    const ctxB = fakeLocationContext("/tmp/w1-b")
    const engineA = createStubV2EngineFactory({ ctx: ctxA, subscribe: true, registerHook: true, timerMs: 5_000 })
    const engineB = createStubV2EngineFactory({ ctx: ctxB, subscribe: true, registerHook: true, timerMs: 5_000 })

    // when
    const runtimeA = await startV2Runtime(ctxA, { engineFactory: engineA.factory, sideEffects })
    const runtimeB = await startV2Runtime(ctxB, { engineFactory: engineB.factory, sideEffects })

    // then
    expect(engineA.state.starts).toEqual(["/tmp/w1-a"])
    expect(engineB.state.starts).toEqual(["/tmp/w1-b"])
    expect(sideEffects.tallies.sweepStarts).toBe(1)
    expect(sideEffects.tallies.telemetryCalls).toBe(1)
    expect(sideEffects.tallies.skillSourceStarts).toBe(1)
    expect(sideEffects.tallies.openclawStarts).toBe(1)
    expect(sideEffects.tallies.migrationCwds).toEqual(["/tmp/w1-a", "/tmp/w1-b"])
    for (const name of ["sweep", "openclaw", "skillSource", "telemetry"]) {
      expect(snapshotOf(name), `${name} while two runtimes are live`).toEqual({ live: 2, started: 1, maxConcurrent: 1 })
    }
    expect(activeV2Runtimes.size).toBe(2)
    expect(runtimeA.directory).toBe("/tmp/w1-a")
    expect(runtimeB.directory).toBe("/tmp/w1-b")

    // when
    await runtimeA.stop()

    // then
    expect(engineA.state.disposes).toBe(1)
    expect(runtimeA.abort.signal.aborted).toBe(true)
    expect(engineB.state.disposes).toBe(0)
    expect(sideEffects.tallies.skillSourceStops).toBe(0)
    for (const name of ["sweep", "openclaw", "skillSource", "telemetry"]) {
      expect(snapshotOf(name), `${name} after one stop`).toEqual({ live: 1, started: 1, maxConcurrent: 1 })
    }
    expect(activeV2Runtimes.size).toBe(1)

    // when
    await runtimeB.stop()

    // then
    expect(engineB.state.disposes).toBe(1)
    expect(sideEffects.tallies.skillSourceStops).toBe(1)
    for (const name of ["sweep", "openclaw", "skillSource", "telemetry"]) {
      expect(snapshotOf(name), `${name} after the last stop`).toEqual({ live: 0, started: 1, maxConcurrent: 0 })
    }
    expect(activeV2Runtimes.size).toBe(0)
  })

  test("#given a host reload of the same location #when setup starts a second runtime #then the previous runtime stops first", async () => {
    // given
    const sideEffects = createFakeV2SideEffects()
    const ctx = fakeLocationContext("/tmp/w1-reload")
    const first = createStubV2EngineFactory({ ctx })
    const second = createStubV2EngineFactory({ ctx })

    // when
    await startV2Runtime(ctx, { engineFactory: first.factory, sideEffects })
    const runtime = await startV2Runtime(ctx, { engineFactory: second.factory, sideEffects })

    // then
    expect(first.state.disposes).toBe(1)
    expect(second.state.starts).toEqual(["/tmp/w1-reload"])
    expect(snapshotOf("sweep")).toEqual({ live: 1, started: 2, maxConcurrent: 1 })
    expect(activeV2Runtimes.size).toBe(1)
    expect(activeV2Runtimes.get("/tmp/w1-reload")).toBe(runtime)
    await runtime.stop()
  })

  test("#given a live runtime #when the runtime stops #then the event subscription emits exactly one stats line", async () => {
    // given
    const sideEffects = createFakeV2SideEffects()
    const ctx = fakeLocationContext("/tmp/w1-stats")
    const engine = createStubV2EngineFactory({ ctx, subscribe: true, timerMs: 5_000 })
    const runtime = await startV2Runtime(ctx, { engineFactory: engine.factory, sideEffects })
    const originalDebug = console.debug
    const lines: string[] = []
    console.debug = (...values: unknown[]) => {
      lines.push(values.map((value) => String(value)).join(" "))
    }

    // when
    try {
      await runtime.stop()
    } finally {
      console.debug = originalDebug
    }

    // then
    expect(runtime.subscriptions?.length, "v2-events loop + task-23 plan-source raw listener").toBe(2)
    const stats = lines.filter((line) => line.startsWith("[opencode-v2] event stats "))
    expect(stats, "exactly one stats line at runtime stop").toHaveLength(1)
    const parsed = JSON.parse((stats[0] ?? "").slice("[opencode-v2] event stats ".length)) as Record<string, unknown>
    expect(parsed.directory).toBe("/tmp/w1-stats")
    for (const key of [
      "eventsSeen",
      "translated",
      "fetchWorthy",
      "coalesceBatches",
      "contextFetches",
      "contextFetchFailures",
    ]) {
      expect(typeof parsed[key], `counter ${key} is a number`).toBe("number")
    }
  })

  test("#given a stopped runtime #when cleanup runs twice #then dispose runs exactly once without error", async () => {
    // given
    const sideEffects = createFakeV2SideEffects()
    const ctx = fakeLocationContext("/tmp/w1-twice")
    const engine = createStubV2EngineFactory({ ctx })
    const runtime = await startV2Runtime(ctx, { engineFactory: engine.factory, sideEffects })

    // when
    await runtime.stop()
    await runtime.stop()

    // then
    expect(engine.state.disposes).toBe(1)
    expect(sideEffects.tallies.skillSourceStops).toBe(1)
    expect(snapshotOf("skillSource")).toEqual({ live: 0, started: 1, maxConcurrent: 0 })
    expect(activeV2Runtimes.size).toBe(0)
  })

  test("#given two listed omo plugin sources #when the engine starts #then it no-ops with the duplicate warning (V1 semantics)", async () => {
    // given
    const sideEffects = createFakeV2SideEffects()
    const ctx = createFakeV2Context({
      location: {
        directory: "/tmp/w1-duplicate",
        project: { id: "prj_w1_duplicate", directory: "/tmp/w1-duplicate", canonical: "/tmp/w1-duplicate" },
      },
      plugins: [
        { id: "oh-my-openagent", source: { type: "local", path: "/tmp/w1-duplicate" } },
        { id: "oh-my-openagent", source: { type: "package", target: "oh-my-openagent@5.1.83" } },
      ],
    })
    const engine = createStubV2EngineFactory({ ctx })

    // when
    const runtime = await startV2Runtime(ctx, { engineFactory: engine.factory, sideEffects })

    // then
    expect(engine.state.duplicateWarnings).toHaveLength(1)
    expect(engine.state.duplicateWarnings[0]).toContain("Duplicate OMO plugin entries detected")
    expect(Object.keys(runtime.engine)).toEqual([])
    expect(engine.state.entryLogs).toHaveLength(1)
    expect(sideEffects.tallies.sweepStarts).toBe(1)
    expect(sideEffects.tallies.telemetryCalls).toBe(0)

    // when
    await runtime.stop()

    // then
    // the no-op engine returns no dispose hook, exactly like the V1 duplicate path
    expect(engine.state.disposes).toBe(0)
    expect(snapshotOf("sweep")).toEqual({ live: 0, started: 1, maxConcurrent: 0 })
  })

  test("#given the log mirror #when the engine starts #then the V1 entry marker reaches the plugin console", async () => {
    // given
    const sideEffects = createFakeV2SideEffects()
    const ctx = fakeLocationContext("/tmp/w1-entry")
    const engine = createStubV2EngineFactory({ ctx })
    const captured = captureConsoleLines()

    try {
      // when
      const runtime = await startV2Runtime(ctx, { engineFactory: engine.factory, sideEffects })
      await runtime.stop()

      // then
      expect(captured.lines).toContain("[oh-my-openagent] ENTRY - plugin loading")
    } finally {
      captured.restore()
    }
  })
})

describe("v2 runtime reload cycles", () => {
  test("#given N setup and cleanup cycles #when they run in one process #then every process-wide dep ends at live 0 with no pending state", async () => {
    // given
    const sideEffects = createFakeV2SideEffects()

    // when
    const report = await runV2ReloadCycles({ cycles: 3, sideEffects })

    // then
    expect(report.engineStarts).toBe(3)
    expect(report.engineDisposes).toBe(3)
    expect(report.pendingTimers).toBe(0)
    expect(report.openSubscriptions).toBe(0)
    expect(report.openRegistrations).toBe(0)
    for (const name of ["sweep", "skillSource", "telemetry"] as const) {
      expect(report.snapshot[name], `${name} after the last cycle`).toEqual({ live: 0, started: 3, maxConcurrent: 0 })
    }
    expect(report.snapshot.openclaw, "openclaw never configured in the scenario").toEqual({
      live: 0,
      started: 0,
      maxConcurrent: 0,
    })
    expect(sideEffects.tallies.sweepStarts).toBe(3)
    expect(sideEffects.tallies.telemetryCalls).toBe(3)
    expect(sideEffects.tallies.skillSourceStarts).toBe(3)
    expect(sideEffects.tallies.skillSourceStops).toBe(3)
    expect(sideEffects.tallies.migrationCwds).toEqual(["/tmp/fake-v2"])
    expect(activeV2Runtimes.size).toBe(0)
  })
})
