import { describe, expect, it } from "bun:test"

import { OPENCODE_V2_MIN_VERSION } from "./startup-notice"
import { parseHostVersion } from "./version-guard"

describe("OpenCode 2 host version guard", () => {
  it("admits 2.4.1 above the floor", () => {
    // given
    const input = { name: "opencode", version: "2.4.1", channel: "stable" }

    // when
    const guard = parseHostVersion(input)

    // then
    expect(guard).toEqual({ ok: true, major: 2, minor: 4, patch: 1 })
  })

  it("admits 2.4.0 exactly at the floor", () => {
    // given
    const input = { name: "opencode", version: OPENCODE_V2_MIN_VERSION, channel: "stable" }

    // when
    const guard = parseHostVersion(input)

    // then
    expect(guard).toEqual({ ok: true, major: 2, minor: 4, patch: 0 })
  })

  it("rejects 2.3.9 as below-floor", () => {
    // given
    const input = { name: "opencode", version: "2.3.9", channel: "stable" }

    // when
    const guard = parseHostVersion(input)

    // then
    expect(guard).toEqual({ ok: false, reason: "below-floor", found: "2.3.9" })
  })

  it("rejects 3.0.0 as above-verified", () => {
    // given
    const input = { name: "opencode", version: "3.0.0", channel: "stable" }

    // when
    const guard = parseHostVersion(input)

    // then
    expect(guard).toEqual({ ok: false, reason: "above-verified", found: "3.0.0" })
  })

  it("rejects 1.19.4 as unsupported-major", () => {
    // given
    const input = { name: "opencode", version: "1.19.4", channel: "stable" }

    // when
    const guard = parseHostVersion(input)

    // then
    expect(guard).toEqual({ ok: false, reason: "unsupported-major", found: "1.19.4" })
  })

  it("rejects a missing version", () => {
    // given
    const input = { name: "opencode", channel: "stable" }

    // when
    const guard = parseHostVersion(input)

    // then
    expect(guard).toEqual({ ok: false, reason: "missing-version", found: "" })
  })

  it("rejects a malformed version", () => {
    // given
    const input = { name: "opencode", version: "2.4.x", channel: "stable" }

    // when
    const guard = parseHostVersion(input)

    // then
    expect(guard).toEqual({ ok: false, reason: "unparseable", found: "2.4.x" })
  })

  it("pins the floor constant the matrix and the notice rely on", () => {
    expect(OPENCODE_V2_MIN_VERSION).toBe("2.4.0")
  })
})
