import { selectRuntimeSecuritySkills } from "../../features/opencode-runtime-skills"
import { defaultPluginModuleDeps, type PluginModuleDeps } from "../../testing/create-plugin-module"
import type { V2EngineHooks, V2EngineModule, V2EngineStartInput } from "../runtime/start-v2-runtime"
import { resetV2ProcessStateForTesting, v2ProcessSnapshot, type V2EngineOverrideDeps, type V2ProcessDepStatus } from "../runtime/v2-runtime-deps"
import { startV2Runtime } from "../runtime/start-v2-runtime"
import type { FakeV2Context } from "./fake-v2-context"
import { createFakeV2Context } from "./fake-v2-context"
import type { FakeScheduler } from "./fake-v2-registry"
import type { FakeV2SideEffects } from "./fake-v2-side-effects"

// Stub engine factory for the OpenCode 2 runtime tests (plan task 13). The
// server body replays the create-plugin-module call order for exactly the
// deps task 13 overrides, plus one simulated manager-level event
// subscription, session hook registration and scheduler timer so
// stopV2Runtime has real cleanup to release. The state records what happened
// for the row assertions; counting scheduler and reload-cycle runner included.

export type StubV2EngineState = {
  readonly starts: string[]
  readonly entryLogs: string[]
  readonly duplicateWarnings: string[]
  readonly skillPluginWarnings: string[]
  disposes: number
  readonly registrations: Array<{ disposed: boolean }>
  readonly subscriptions: Array<{ ended: boolean }>
  readonly timers: Array<{ cancelled: boolean }>
}

export type StubV2EngineOptions = {
  readonly ctx: FakeV2Context
  readonly subscribe?: boolean
  readonly registerHook?: boolean
  readonly timerMs?: number
}

export type StubV2EngineFactory = {
  readonly factory: (overrides: V2EngineOverrideDeps) => V2EngineModule
  readonly state: StubV2EngineState
}

export function createStubV2EngineFactory(options: StubV2EngineOptions): StubV2EngineFactory {
  const state: StubV2EngineState = {
    starts: [],
    entryLogs: [],
    duplicateWarnings: [],
    skillPluginWarnings: [],
    disposes: 0,
    registrations: [],
    subscriptions: [],
    timers: [],
  }
  // The stub engine sees the same dependency bag the real engine does: the
  // D-9 overrides merged onto the defaults (Object.assign keeps every key
  // present without a cast).
  const factory = (overrides: V2EngineOverrideDeps): V2EngineModule => ({
    id: "stub-oh-my-openagent",
    server: async (input: V2EngineStartInput): Promise<V2EngineHooks> => {
      const deps = Object.assign({}, defaultPluginModuleDeps, overrides)
      state.starts.push(input.directory)
      deps.installAgentSortShim()
      deps.log("[oh-my-openagent] ENTRY - plugin loading", { directory: input.directory })
      state.entryLogs.push(input.directory)
      deps.runOpenCodeStartupMigration({ cwd: input.directory })
      const validation = deps.loadConfigChain(input.directory)
      void deps.startOmoProcessSweep().catch(() => {})
      const duplicate = deps.detectDuplicateOmoPlugin(input.directory)
      if (duplicate.detected) {
        const warning = deps.getDuplicateOmoPluginWarning(duplicate.duplicatePlugins)
        state.duplicateWarnings.push(warning)
        console.warn(warning)
        return {}
      }
      const skillPlugin = deps.detectExternalSkillPlugin(input.directory)
      if (skillPlugin.detected && skillPlugin.pluginName !== null) {
        state.skillPluginWarnings.push(deps.getSkillPluginConflictWarning(skillPlugin.pluginName))
      }
      deps.injectServerAuthIntoClient(input.client)
      deps.recordPluginTelemetry({ configEnabled: validation.config.telemetry })
      deps.ensureTuiPluginEntry()
      deps.initLiveServerRoute({ serverUrl: undefined, directory: input.directory, inProcessClient: input.client })
      deps.setLiveParentWakeRoutingDisabled(validation.config.experimental?.disable_live_parent_wake_routing === true)
      deps.warmLiveServerProbe()
      let runtimeSkillSource: Awaited<ReturnType<PluginModuleDeps["createRuntimeSkillSourceServer"]>> | undefined
      const runtimeSkills = selectRuntimeSecuritySkills(validation.config)
      if (runtimeSkills.length > 0) {
        runtimeSkillSource = await deps.createRuntimeSkillSourceServer({ skills: runtimeSkills })
      }
      if (validation.config.openclaw) {
        await deps.initializeOpenClaw(validation.config.openclaw)
      }
      const disposers: Array<() => void | Promise<void>> = []
      if (options.registerHook) {
        const entry = { disposed: false }
        state.registrations.push(entry)
        const registration = await options.ctx.session.hook("prompt", () => {})
        disposers.push(async () => {
          await registration.dispose()
          entry.disposed = true
        })
      }
      if (options.subscribe) {
        const entry = { ended: false }
        state.subscriptions.push(entry)
        const iterator = options.ctx.event.subscribe({ types: ["session.created"] })[Symbol.asyncIterator]()
        disposers.push(async () => {
          await iterator.return?.()
          entry.ended = true
        })
      }
      if (options.timerMs !== undefined) {
        const entry = { cancelled: false }
        state.timers.push(entry)
        const cancel = options.ctx.__scheduler.setTimeout(() => {}, options.timerMs)
        disposers.push(() => {
          cancel()
          entry.cancelled = true
        })
      }
      return {
        dispose: async () => {
          state.disposes += 1
          runtimeSkillSource?.stop()
          for (const dispose of disposers) await dispose()
        },
      }
    },
  })
  return { factory, state }
}

export function captureConsoleLines(): { readonly lines: readonly string[]; readonly restore: () => void } {
  const original = console.log
  const lines: string[] = []
  console.log = (...values: unknown[]) => {
    lines.push(values.map((value) => String(value)).join(" "))
  }
  return { lines, restore: () => (console.log = original) }
}

export type CountingScheduler = FakeScheduler & {
  readonly pendingTimers: () => number
}

export function createCountingScheduler(): CountingScheduler {
  const cancels = new Set<() => void>()
  return {
    now: () => 0,
    setTimeout: (callback: () => void, ms: number) => {
      const cancel = () => {
        cancels.delete(cancel)
      }
      cancels.add(cancel)
      void callback
      void ms
      return cancel
    },
    pendingTimers: () => cancels.size,
  }
}

export type V2ReloadCycleReport = {
  readonly engineStarts: number
  readonly engineDisposes: number
  readonly pendingTimers: number
  readonly openSubscriptions: number
  readonly openRegistrations: number
  readonly snapshot: Record<string, V2ProcessDepStatus>
}

export async function runV2ReloadCycles(input: {
  readonly cycles: number
  readonly sideEffects: FakeV2SideEffects
}): Promise<V2ReloadCycleReport> {
  resetV2ProcessStateForTesting()
  const scheduler = createCountingScheduler()
  const ctx = createFakeV2Context({ scheduler })
  const { factory, state } = createStubV2EngineFactory({ ctx, subscribe: true, registerHook: true, timerMs: 5_000 })
  for (let cycle = 0; cycle < input.cycles; cycle += 1) {
    const runtime = await startV2Runtime(ctx, { engineFactory: factory, sideEffects: input.sideEffects })
    await runtime.stop()
  }
  return {
    engineStarts: state.starts.length,
    engineDisposes: state.disposes,
    pendingTimers: scheduler.pendingTimers(),
    openSubscriptions: state.subscriptions.filter((subscription) => !subscription.ended).length,
    openRegistrations: state.registrations.filter((registration) => !registration.disposed).length,
    snapshot: v2ProcessSnapshot(),
  }
}
