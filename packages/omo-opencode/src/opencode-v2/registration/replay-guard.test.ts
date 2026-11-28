import { describe, expect, it } from "bun:test"

import { guardReplayEditor, guardReplayStep } from "./replay-guard"

describe("guardReplayEditor", () => {
  it("#given a transform that mutates the value #when it runs #then the mutated value returns", () => {
    // given
    const guarded = guardReplayEditor<string>("agent-registration", (value) => `${value}!`)

    // when
    const result = guarded("sisyphus")

    // then
    expect(result).toBe("sisyphus!")
  })

  it("#given a transform that throws #when it runs #then the unmodified value continues", () => {
    // given
    const guarded = guardReplayEditor<string>("agent-registration", () => {
      throw new Error("transform boom")
    })

    // when
    const result = guarded("pristine")

    // then
    expect(result).toBe("pristine")
  })
})

describe("guardReplayStep", () => {
  it("#given a step that throws #when it runs #then the step resolves instead of failing the recompute", async () => {
    // given
    const guarded = guardReplayStep<{ marker: string }>("tool-registration", () => {
      throw new Error("step boom")
    })

    // when
    const run = guarded({ marker: "input" })

    // then
    await expect(run).resolves.toBeUndefined()
  })

  it("#given a step that runs #when it executes #then the step effect lands exactly once", async () => {
    // given
    let runs = 0
    const guarded = guardReplayStep("count-step", () => {
      runs += 1
    })

    // when
    await guarded(undefined)

    // then
    expect(runs).toBe(1)
  })
})
