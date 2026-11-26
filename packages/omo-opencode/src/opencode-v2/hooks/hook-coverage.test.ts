import { describe, expect, it } from "bun:test"

import { createHooks } from "../../create-hooks"
import { createFakeV2Context } from "../parity/fake-v2-context"
import { createFakeV2SideEffects } from "../parity/fake-v2-side-effects"
import { LANDED_WAVES } from "../parity/lan"
import { V2_LIMITS } from "../parity/v2-limits"
import { startV2Runtime } from "../runtime/start-v2-runtime"
import { resetV2ProcessStateForTesting } from "../runtime/v2-runtime-deps"
import { resetV2HookMarkersForTesting } from "../runtime/hook-markers"
import { releaseAllPromptAsyncReservationsForTesting } from "@oh-my-opencode/utils/prompt-async-gate"
import {
  createHookInvocationRecorder,
  coverageLimitIds,
  spyCreatedHooks,
  V2_HOOK_COVERAGE_LEDGER,
} from "./hook-coverage"
import { resetCompactionAdaptationStateForTesting } from "./adapt-compaction-hooks"
import { resetIdleContinuationStateForTesting } from "./adapt-idle-continuation"

// Hook reachability ledger test (plan task 19). The real engine boots over
// the hermetic ctx with every composed hook record wrapped in an invocation
// spy installed through the createHooks dep, the wave-2 adapter trigger set
// fires, and every ledger key marked reachable with coverageWave at or below
// the landed wave count must have been invoked. The full-reachability sweep
// activates when the wave gate reaches 4 without changing this assertion.

async function flushAsync(ms = 50): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

describe("V2_HOOK_COVERAGE_LEDGER", () => {
  it("#given the ledger entries #when checked statically #then keys are unique, reachable entries carry a coverage wave and unreachable entries cite a seeded limit", () => {
    // given
    const keys = V2_HOOK_COVERAGE_LEDGER.map((entry) => entry.key)

    // then
    expect(new Set(keys).size, "ledger keys are unique").toBe(keys.length)
    const limitIds = coverageLimitIds()
    for (const entry of V2_HOOK_COVERAGE_LEDGER) {
      if (entry.status === "reachable") {
        expect(typeof entry.coverageWave, `${entry.key} needs a coverage wave`).toBe("number")
      } else {
        expect(entry.limitId !== undefined, `${entry.key} needs a limit id`).toBe(true)
        expect(limitIds.has(entry.limitId ?? ""), `${entry.key} cites an unseeded limit ${entry.limitId}`).toBe(true)
        expect(
          V2_LIMITS.find((limit) => limit.id === entry.limitId)?.is.includes("IS-13"),
          `${entry.key} cites ${entry.limitId} outside the ledger IS`,
        ).toBe(true)
      }
    }
  })

  it("#given the real engine over the hermetic ctx #when the wave-2 trigger set fires #then every reachable key of a landed wave has been invoked", async () => {
    // given
    resetV2ProcessStateForTesting()
    resetV2HookMarkersForTesting()
    resetCompactionAdaptationStateForTesting()
    resetIdleContinuationStateForTesting()
    releaseAllPromptAsyncReservationsForTesting()
    const ctx = createFakeV2Context()
    const recorder = createHookInvocationRecorder()
    let spiedKeys: readonly string[] = []
    const runtime = await startV2Runtime(ctx, {
      engineDeps: {
        createHooks: (args) => {
          const hooks = spyCreatedHooks(createHooks(args), recorder)
          spiedKeys = Object.keys(hooks)
            .filter((key) => key !== "disposeHooks")
            .sort()
          return hooks
        },
      },
      sideEffects: createFakeV2SideEffects(),
    })
    try {
      await ctx.session.create({ id: "ses_coverage" })
      ctx.__pushEvent({ type: "session.created", created: 1, data: { sessionID: "ses_coverage", title: "t" } })
      await flushAsync()

      // when: the wave-2 adapter trigger set
      ctx.__pushEvent({ type: "session.compaction.started", created: 2, data: { sessionID: "ses_coverage" } })
      await flushAsync()
      ctx.__pushEvent({
        type: "session.compaction.ended",
        created: 3,
        data: { sessionID: "ses_coverage", summary: "the finished summary" },
      })
      await flushAsync()
      ctx.__pushEvent({
        type: "session.status",
        created: 4,
        data: { sessionID: "ses_coverage", status: { type: "idle" } },
      })
      await flushAsync(300)
      await ctx.__fire("session", "experimental.idle", { sessionID: "ses_coverage", background: [] })
      await flushAsync(100)

      // then
      const ledgerKeys = V2_HOOK_COVERAGE_LEDGER.map((entry) => entry.key).sort()
      expect(ledgerKeys, "the ledger must cover exactly the composed hook records").toEqual(spiedKeys)
      const missed: string[] = []
      for (const entry of V2_HOOK_COVERAGE_LEDGER) {
        if (entry.status !== "reachable" || (entry.coverageWave ?? 0) > LANDED_WAVES) continue
        if (!recorder.invoked(entry.key)) missed.push(entry.key)
      }
      expect(missed, `landed-wave coverage misses: ${missed.join(",")}`).toEqual([])
    } finally {
      await runtime.stop()
      releaseAllPromptAsyncReservationsForTesting()
    }
  }, 60000)
})
