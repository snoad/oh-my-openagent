import { OhMyOpenCodeConfigSchema } from "../../config"
import type { PluginConfigValidation } from "../../config/validate"
import type { V2EngineSideEffects } from "../runtime/v2-runtime-deps"

// Injectable engine side effects for the OpenCode 2 runtime tests (plan task
// 13). Every hermetic runtime start swaps the process-wide dependency inners
// through this bag: the refcount wrappers in v2-runtime-deps still run, only
// the observable effects become counters. The chain loader answers with a
// schema-parsed default config so selectRuntimeSecuritySkills picks the two
// security skills exactly as on a default host, and the openclaw option turns
// the initializeOpenClaw branch on.

export type FakeV2SideEffectTallies = {
  sweepStarts: number
  openclawStarts: number
  skillSourceStarts: number
  skillSourceStops: number
  telemetryCalls: number
  migrationCwds: string[]
  chainDirectories: string[]
}

export type FakeV2SideEffects = V2EngineSideEffects & {
  readonly tallies: FakeV2SideEffectTallies
}

export type FakeV2SideEffectsOptions = {
  readonly openclaw?: boolean
  readonly disabledHooks?: readonly string[]
}

export function createFakeV2SideEffects(options?: FakeV2SideEffectsOptions): FakeV2SideEffects {
  const tallies: FakeV2SideEffectTallies = {
    sweepStarts: 0,
    openclawStarts: 0,
    skillSourceStarts: 0,
    skillSourceStops: 0,
    telemetryCalls: 0,
    migrationCwds: [],
    chainDirectories: [],
  }
  return {
    tallies,
    startOmoProcessSweep: async () => {
      tallies.sweepStarts += 1
    },
    initializeOpenClaw: async () => {
      tallies.openclawStarts += 1
    },
    createRuntimeSkillSourceServer: async () => {
      tallies.skillSourceStarts += 1
      return {
        url: "http://127.0.0.1:61337/fake-skill-source",
        fetch: () => new Response("fake skill source"),
        stop: () => {
          tallies.skillSourceStops += 1
        },
      }
    },
    recordPluginTelemetry: () => {
      tallies.telemetryCalls += 1
    },
    runOpenCodeStartupMigration: (input) => {
      tallies.migrationCwds.push(input.cwd)
      return {
        error: undefined,
        journalResumed: false,
        migratedFrom: [],
        reloadRequired: false,
        results: [],
        skippedConflictCount: 0,
        targetBackupPaths: [],
      }
    },
    loadConfigChain: (directory) => {
      tallies.chainDirectories.push(directory)
      return fakeChainValidation(options)
    },
  }
}

function fakeChainValidation(options?: FakeV2SideEffectsOptions): PluginConfigValidation {
  const config = OhMyOpenCodeConfigSchema.parse({
    ...(options?.openclaw ? { openclaw: { enabled: true } } : {}),
    ...(options?.disabledHooks ? { disabled_hooks: options.disabledHooks } : {}),
  })
  return { valid: true, messages: [], warnings: [], path: null, config }
}
