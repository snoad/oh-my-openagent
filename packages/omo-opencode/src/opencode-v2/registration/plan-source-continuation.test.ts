import { describe, expect, it } from "bun:test"

import { createRecordContinuation, MAX_RECORD_CONTINUATION_ROUNDS } from "./plan-source-continuation"

// The post-startup record-change continuation is the chain the real host
// looped on: consecutive record deltas armed a recompute forever. The policy
// under test arms one debounced continuation per delta until the bound, logs
// the stop once, and lets a quiet pass reset the chain.

describe("createRecordContinuation", () => {
  it("#given a fresh chain #when every pass reports a record change #then the first passes arm and the bound pass stops without arming", () => {
    // given
    let armed = 0
    const continuation = createRecordContinuation(MAX_RECORD_CONTINUATION_ROUNDS, () => {
      armed += 1
    })
    const moving = new Set(["tool", "agent"])

    // when: bound consecutive moving passes
    for (let round = 0; round < MAX_RECORD_CONTINUATION_ROUNDS; round += 1) {
      continuation.onPass(moving)
    }

    // then: bound-1 continuations armed, then the chain stopped
    expect(armed).toBe(MAX_RECORD_CONTINUATION_ROUNDS - 1)

    // when: further moving passes after the stop
    for (let round = 0; round < 5; round += 1) {
      continuation.onPass(moving)
    }

    // then: nothing arms anymore
    expect(armed).toBe(MAX_RECORD_CONTINUATION_ROUNDS - 1)
  })

  it("#given a stopped chain #when a quiet pass reports no record change #then the chain resets and arms again", () => {
    // given
    let armed = 0
    const continuation = createRecordContinuation(MAX_RECORD_CONTINUATION_ROUNDS, () => {
      armed += 1
    })
    const moving = new Set(["mcp"])
    for (let round = 0; round < MAX_RECORD_CONTINUATION_ROUNDS; round += 1) continuation.onPass(moving)
    expect(armed).toBe(MAX_RECORD_CONTINUATION_ROUNDS - 1)

    // when: a quiet pass
    continuation.onPass(new Set())

    // then: the next moving pass arms again
    continuation.onPass(moving)
    expect(armed).toBe(MAX_RECORD_CONTINUATION_ROUNDS)
  })
})
