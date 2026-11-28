import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { _flushForTesting, _resetLoggerForTesting, _setLoggerForTesting } from "../../shared/logger"
import {
  createRecordContinuation,
  MAX_RECONCILE_CONTINUATION_ROUNDS,
  type ReconcileSignals,
} from "./plan-source-continuation"

// The post-startup continuation arms only for a change that needs a
// reconciliation pass (a projected-base movement or lost own output); a pass
// with neither signal resets the chain. The bound is the pathological-host
// safety net and logs exactly one stop line per chain.

const moved: ReconcileSignals = { projectedBaseMoved: true, ownToolsLost: false }
const lost: ReconcileSignals = { projectedBaseMoved: false, ownToolsLost: true }
const quiet: ReconcileSignals = { projectedBaseMoved: false, ownToolsLost: false }

describe("createRecordContinuation", () => {
  it("#given a fresh chain #when every pass reports a projected-base movement #then the first passes arm and the bound pass stops with one log line", () => {
    // given
    const logDir = mkdtempSync(join(tmpdir(), "plan-source-cont-"))
    const logFile = join(logDir, "log")
    _setLoggerForTesting({ filePath: logFile })
    try {
      let armed = 0
      const continuation = createRecordContinuation(MAX_RECONCILE_CONTINUATION_ROUNDS, () => {
        armed += 1
      })

      // when: bound consecutive moving passes
      const verdicts = Array.from({ length: MAX_RECONCILE_CONTINUATION_ROUNDS }, () => continuation.onPass(moved))

      // then: bound-1 continuations armed, the bound pass stopped
      expect(armed).toBe(MAX_RECONCILE_CONTINUATION_ROUNDS - 1)
      expect(verdicts.filter((verdict) => verdict === "armed")).toHaveLength(MAX_RECONCILE_CONTINUATION_ROUNDS - 1)
      expect(verdicts[verdicts.length - 1]).toBe("stopped")

      // when: further moving passes after the stop
      for (let round = 0; round < 5; round += 1) continuation.onPass(moved)

      // then: nothing arms anymore and exactly one stop line is logged
      expect(armed).toBe(MAX_RECONCILE_CONTINUATION_ROUNDS - 1)
      _flushForTesting()
      const logged = readFileSync(logFile, "utf8")
      expect(logged.split("stopping the recompute continuation")).toHaveLength(2)
    } finally {
      _resetLoggerForTesting()
      rmSync(logDir, { recursive: true, force: true })
    }
  })

  it("#given a stopped chain #when a quiet pass reports no signal #then the chain resets and arms again on either signal", () => {
    // given
    let armed = 0
    const continuation = createRecordContinuation(MAX_RECONCILE_CONTINUATION_ROUNDS, () => {
      armed += 1
    })
    for (let round = 0; round < MAX_RECONCILE_CONTINUATION_ROUNDS; round += 1) continuation.onPass(lost)
    expect(armed).toBe(MAX_RECONCILE_CONTINUATION_ROUNDS - 1)

    // when: a quiet pass
    expect(continuation.onPass(quiet)).toBe("settled")

    // then: the next moving pass arms again, on either signal
    expect(continuation.onPass(moved)).toBe("armed")
    expect(continuation.onPass(quiet)).toBe("settled")
    expect(continuation.onPass(lost)).toBe("armed")
    expect(armed).toBe(MAX_RECONCILE_CONTINUATION_ROUNDS + 1)
  })
})
