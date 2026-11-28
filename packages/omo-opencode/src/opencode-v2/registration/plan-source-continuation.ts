// Bounded post-startup continuation policy. A pass arms the debounced
// reconciliation recompute only for a change that needs one: a projected-base
// movement (a foreign change recorded this pass reaches the plan only in the
// next pass) or lost own output (the base filters the plugin's own tools, so
// a host-side wipe is invisible to the projection). Projection-invisible
// registry churn - the agent name form, a host tool's description - produces
// neither signal and arms nothing, so a steady host never continues.

import { log } from "../../shared"

// Bound justification: one real own-tool wipe costs two passes (a detection
// pass that reports the loss, a restore pass that re-applies and reloads the
// tools domain); eight rounds tolerate four back-to-back wipe cycles, far
// beyond the single async tool-registry init wipe observed on the real host.
// A steady host arms nothing and never reaches the bound.
export const MAX_RECONCILE_CONTINUATION_ROUNDS = 8

const LOG_MARKER = "[opencode-v2] plan-source"

export type ReconcileSignals = {
  readonly projectedBaseMoved: boolean
  readonly ownToolsLost: boolean
}

export type ContinuationVerdict = "armed" | "stopped" | "settled"

export type RecordContinuation = {
  readonly onPass: (signals: ReconcileSignals) => ContinuationVerdict
}

export function createRecordContinuation(bound: number, arm: () => void): RecordContinuation {
  let rounds = 0
  let stopped = false
  return {
    onPass: (signals) => {
      if (!signals.projectedBaseMoved && !signals.ownToolsLost) {
        rounds = 0
        stopped = false
        return "settled"
      }
      if (stopped) return "stopped"
      rounds += 1
      if (rounds >= bound) {
        stopped = true
        log(
          `${LOG_MARKER}: forced reconciliation passes persisted across ${String(rounds)} consecutive ` +
            `recomputes (projected base moved: ${String(signals.projectedBaseMoved)}, own tools lost: ` +
            `${String(signals.ownToolsLost)}); stopping the recompute continuation`,
        )
        return "stopped"
      }
      arm()
      return "armed"
    },
  }
}
