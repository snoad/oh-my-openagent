import { describe, expect, it } from "bun:test"

import tuiModule from "../tui"
import { OPENCODE_V2_MIN_VERSION } from "./startup-notice"
import { showOpenCodeV2Notice } from "./tui-entry"

type ShownToast = { readonly title: string; readonly message: string; readonly variant: string }

type GuardedContext = Parameters<typeof showOpenCodeV2Notice>[0]

function recordingContext(version: string): {
  readonly shown: ShownToast[]
  readonly context: GuardedContext
} {
  const shown: ShownToast[] = []
  return {
    shown,
    context: {
      app: { name: "opencode", version, channel: "stable" },
      ui: {
        toast: {
          show: (options) => {
            shown.push(options)
          },
        },
      },
    },
  }
}

describe("OpenCode 2 TUI notice", () => {
  it("shows exactly one warning toast naming the minimum for a below-floor host", () => {
    // given
    const { shown, context } = recordingContext("2.3.9")

    // when
    showOpenCodeV2Notice(context)

    // then
    expect(shown).toHaveLength(1)
    expect(shown[0]?.variant).toBe("warning")
    expect(shown[0]?.message).toContain(OPENCODE_V2_MIN_VERSION)
  })

  it("shows no toast for a supported host", () => {
    // given
    const { shown, context } = recordingContext("2.4.1")

    // when
    showOpenCodeV2Notice(context)

    // then
    expect(shown).toHaveLength(0)
  })

  it("keeps the V1 tui entry and adds a V2 setup that guards on every start", async () => {
    // given
    const definition: Record<string, unknown> = tuiModule
    const { shown, context } = recordingContext("2.3.9")
    const setup = definition["setup"]

    // when
    if (typeof setup !== "function") throw new Error("setup missing")
    await setup(context)
    await setup(context)

    // then
    expect(definition["id"]).toBe("oh-my-openagent:tui")
    expect(typeof definition["tui"]).toBe("function")
    expect(shown).toHaveLength(2)
  })
})
