import { describe, expect, it } from "bun:test"

import { releaseAllPromptAsyncReservationsForTesting } from "@oh-my-opencode/utils/prompt-async-gate"

import { validatePluginConfig } from "../../config/validate"
import { createPluginInterface } from "../../plugin-interface"
import { createFakeV2Context } from "../parity/fake-v2-context"
import { createFakeV2SideEffects } from "../parity/fake-v2-side-effects"
import { startV2Runtime } from "../runtime/start-v2-runtime"
import { activeV2Runtimes, resetV2ProcessStateForTesting } from "../runtime/v2-runtime-deps"

const CANONICAL_AGENTS = ["sisyphus", "hephaestus", "prometheus", "atlas"] as const

// The V1 pipeline remaps agent keys to display names ("Sisyphus - ultraworker")
// and the hidden-config-key aliases add the config keys back; both normalize
// to the canonical lowercase name cut at " - ".
function canonicalAgentKeys(keys: readonly string[]): string[] {
  return keys.map((key) => (key.split(" - ")[0] ?? key).toLowerCase())
}

describe("registration plan over the real V1 config handler", () => {
  it("#given the real engine over the hermetic ctx #when the plan source runs the initial recompute #then the added agents carry the four canonical omo agents and the added commands are not empty", async () => {
    // given
    resetV2ProcessStateForTesting()
    releaseAllPromptAsyncReservationsForTesting()
    const ctx = createFakeV2Context()

    // when
    const runtime = await startV2Runtime(ctx, {
      sideEffects: createFakeV2SideEffects(),
      engineDeps: {
        loadConfigChain: (directory, environment) => {
          const validation = validatePluginConfig(directory, environment)
          return {
            ...validation,
            config: {
              ...validation.config,
              agents: { ...validation.config.agents, atlas: { model: "anthropic/claude-sonnet-5" } },
            },
          }
        },
      },
    })
    try {
      const plan = runtime.planSource?.getPlan()

      // then
      expect(plan, "the initial recompute produced a plan").toBeDefined()
      const agentKeys = canonicalAgentKeys(Object.keys(plan?.agents.added ?? {}))
      for (const canonical of CANONICAL_AGENTS) {
        expect(agentKeys, `canonical agent ${canonical} missing from plan.agents.added`).toContain(canonical)
      }
      expect(Object.keys(plan?.commands.added ?? {}).length, "commands added").toBeGreaterThan(0)
    } finally {
      await runtime.stop()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  it("#given a plugin interface whose config handler rejects #when startV2Runtime boots #then the boot rejects with that error and logs exactly the registration-failed marker", async () => {
    // given
    resetV2ProcessStateForTesting()
    const ctx = createFakeV2Context()
    const lines: string[] = []
    const originalWarn = console.warn
    console.warn = (...values: unknown[]) => {
      lines.push(values.map((value) => String(value)).join(" "))
    }
    let failure: unknown
    try {
      await startV2Runtime(ctx, {
        sideEffects: createFakeV2SideEffects(),
        engineDeps: {
          createPluginInterface: (args) => {
            const pluginInterface = createPluginInterface(args)
            return { ...pluginInterface, config: async () => Promise.reject(new Error("pipeline boom")) }
          },
        },
      })
    } catch (error) {
      failure = error
    } finally {
      console.warn = originalWarn
      const leftover = activeV2Runtimes.get(ctx.location.directory)
      if (leftover !== undefined) await leftover.stop()
    }

    // then
    expect(lines, "the exact registration-failed marker line").toContain("[opencode-v2] registration failed")
    expect((failure as Error | undefined)?.message).toBe("pipeline boom")
  })
})
