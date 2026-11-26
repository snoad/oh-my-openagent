import { beforeEach, describe, expect, test } from "bun:test"

import { captureConsoleLines } from "../parity/fake-v2-engine"
import { markHook, resetV2HookMarkersForTesting } from "./hook-markers"

// markHook (plan task 13): logs the "[opencode-v2] hook <name> fired" marker
// once per session per hook; later tasks wire the adapter registrations that
// call it, and the live runner greps the marker out of the sandboxed plugin
// log.

beforeEach(() => {
  resetV2HookMarkersForTesting()
})

describe("markHook", () => {
  test("#given one session and one hook #when the hook fires twice #then the marker logs once", () => {
    // given
    const captured = captureConsoleLines()

    try {
      // when
      markHook("chat.message", "ses_w1")
      markHook("chat.message", "ses_w1")

      // then
      expect(captured.lines).toEqual(["[opencode-v2] hook chat.message fired"])
    } finally {
      captured.restore()
    }
  })

  test("#given two sessions #when the same hook fires for both #then the marker logs once per session", () => {
    // given
    const captured = captureConsoleLines()

    try {
      // when
      markHook("chat.message", "ses_w1_a")
      markHook("chat.message", "ses_w1_a")
      markHook("chat.message", "ses_w1_b")

      // then
      expect(captured.lines).toEqual(["[opencode-v2] hook chat.message fired", "[opencode-v2] hook chat.message fired"])
    } finally {
      captured.restore()
    }
  })

  test("#given two hooks on one session #when both fire #then the marker logs once per hook", () => {
    // given
    const captured = captureConsoleLines()

    try {
      // when
      markHook("chat.message", "ses_w1")
      markHook("tool.execute.before", "ses_w1")

      // then
      expect(captured.lines).toEqual([
        "[opencode-v2] hook chat.message fired",
        "[opencode-v2] hook tool.execute.before fired",
      ])
    } finally {
      captured.restore()
    }
  })
})
