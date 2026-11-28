// Bounded post-startup continuation policy (the record-change chain). A
// record pass that caught a foreign host change arms one debounced
// continuation so the moved base gets its reconciliation pass; consecutive
// deltas beyond the bound mean a record whose raw value moves on every read
// (the real OpenCode 2 host does this after activation), and an unbounded
// chain would recompute for the life of the process.

import { log } from "../../shared"

// Bound justification: a settling host never needs more post-startup rounds
// than the startup drain itself allows (settleMaxRounds); more consecutive
// record deltas mean a moving record, not a host change.
export const MAX_RECORD_CONTINUATION_ROUNDS = 16

const LOG_MARKER = "[opencode-v2] plan-source"

export type RecordContinuation = {
  readonly onPass: (changedDomains: ReadonlySet<string>) => void
}

export function createRecordContinuation(bound: number, arm: () => void): RecordContinuation {
  let rounds = 0
  let stopped = false
  return {
    onPass: (changedDomains) => {
      if (changedDomains.size === 0) {
        rounds = 0
        stopped = false
        return
      }
      if (stopped) return
      rounds += 1
      if (rounds >= bound) {
        stopped = true
        log(
          `${LOG_MARKER}: record changes persisted across ${String(rounds)} consecutive recomputes ` +
            `(${[...changedDomains].join(",")}); stopping the recompute continuation`,
        )
        return
      }
      arm()
    },
  }
}
