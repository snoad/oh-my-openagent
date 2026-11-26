import type { V2Runtime } from "./stop-v2-runtime"
import { validatePluginConfig, type PluginConfigValidation } from "../../config/validate"
import { createRuntimeSkillSourceServer } from "../../features/opencode-runtime-skills"
import { initializeOpenClaw } from "../../openclaw"
import { runOpenCodeStartupMigration, type OpenCodeStartupMigrationResult } from "../../startup-migration"
import type { PluginModuleDeps } from "../../testing/create-plugin-module"
import { log as defaultEngineLog } from "../../shared/logger"
import { recordPluginTelemetry } from "../../shared/posthog"
import { sweepOmoFamiliesBestEffort } from "../../shared/omo-process-sweep"
import { createV2PluginDetectors, type V2ListedPlugin } from "./v2-plugin-identity"

// The D-9 DI override object and the process-wide state of the OpenCode 2 runtime (plan task 13). The override
// neutralizes the V1 host-owned side effects, re-implements the plugin detectors over the listed OpenCode 2
// plugins, always disables the auto-update-checker hook (the host updates version-following plugins itself,
// LIM-18) and wraps the process-wide side effects in ONE refcounted record per process: one sweep, one openclaw
// listener, one runtime skill source server and one telemetry ping, released only after the last runtime stops.
// The engine log is mirrored to the plugin console: the OpenCode 2 host routes plugin console output into the
// serve log, the only host-visible channel for the engine's startup markers.

export type V2EngineSideEffects = {
  readonly startOmoProcessSweep: () => Promise<void>
  readonly initializeOpenClaw: typeof initializeOpenClaw
  readonly createRuntimeSkillSourceServer: typeof createRuntimeSkillSourceServer
  readonly recordPluginTelemetry: typeof recordPluginTelemetry
  readonly runOpenCodeStartupMigration: typeof runOpenCodeStartupMigration
  readonly loadConfigChain: typeof validatePluginConfig
}

export const defaultV2EngineSideEffects: V2EngineSideEffects = {
  startOmoProcessSweep: () => sweepOmoFamiliesBestEffort({ log: defaultEngineLog }),
  initializeOpenClaw,
  createRuntimeSkillSourceServer,
  recordPluginTelemetry,
  runOpenCodeStartupMigration,
  loadConfigChain: validatePluginConfig,
}

const PROCESS_DEP_NAMES = ["sweep", "openclaw", "skillSource", "telemetry"] as const
export type V2ProcessDepName = (typeof PROCESS_DEP_NAMES)[number]

export type V2ProcessDepStatus = { readonly live: number; readonly started: number; readonly maxConcurrent: number }

export type V2SharedHandle = { readonly release: () => Promise<void> }

export type V2RuntimeTracker = {
  readonly releasedDeps: Set<V2ProcessDepName>
  readonly sharedHandles: V2SharedHandle[]
}

export type V2EngineOverrideKey =
  | "installAgentSortShim"
  | "injectServerAuthIntoClient"
  | "initLiveServerRoute"
  | "setLiveParentWakeRoutingDisabled"
  | "warmLiveServerProbe"
  | "ensureTuiPluginEntry"
  | "detectDuplicateOmoPlugin"
  | "detectExternalSkillPlugin"
  | "loadConfigChain"
  | "startOmoProcessSweep"
  | "initializeOpenClaw"
  | "createRuntimeSkillSourceServer"
  | "recordPluginTelemetry"
  | "runOpenCodeStartupMigration"
  | "log"

// Object.assign derives this required-Pick view without a cast: the D-9 keys stay required via the Partial intersection.
export type V2EngineOverrideDeps = Pick<PluginModuleDeps, V2EngineOverrideKey> & Partial<PluginModuleDeps>

type V2ProcessRecord = {
  readonly promise: Promise<unknown>
  readonly disposers: Array<() => void | Promise<void>>
  refCount: number
  release?: Promise<void>
}

type V2SkillSourceServer = Awaited<ReturnType<V2EngineSideEffects["createRuntimeSkillSourceServer"]>>

const processRecords = new Map<V2ProcessDepName, V2ProcessRecord>()
const startedCounts: Record<V2ProcessDepName, number> = { sweep: 0, openclaw: 0, skillSource: 0, telemetry: 0 }
const startupMigrations = new Map<string, OpenCodeStartupMigrationResult>()
export const activeV2Runtimes = new Map<string, V2Runtime>()

function acquireRecord(name: V2ProcessDepName, start: () => Promise<unknown>): V2ProcessRecord {
  const existing = processRecords.get(name)
  if (existing !== undefined && existing.release === undefined) {
    existing.refCount += 1
    return existing
  }
  const record: V2ProcessRecord = { promise: start(), disposers: [], refCount: 1 }
  processRecords.set(name, record)
  startedCounts[name] += 1
  return record
}

export function releaseV2ProcessDep(name: V2ProcessDepName): Promise<void> {
  const record = processRecords.get(name)
  if (record === undefined || record.release !== undefined) return Promise.resolve()
  record.refCount = Math.max(0, record.refCount - 1)
  if (record.refCount === 0) {
    record.release = (async () => {
      for (const disposer of record.disposers) await disposer()
    })().finally(() => processRecords.delete(name))
  }
  return record.release ?? Promise.resolve()
}

function depStatus(name: V2ProcessDepName): V2ProcessDepStatus {
  const record = processRecords.get(name)
  const live = record === undefined || record.release !== undefined ? 0 : record.refCount
  return { live, started: startedCounts[name], maxConcurrent: live > 0 ? 1 : 0 }
}

export function v2ProcessSnapshot(): Record<V2ProcessDepName, V2ProcessDepStatus> {
  type Snapshot = Record<V2ProcessDepName, V2ProcessDepStatus>
  return Object.fromEntries(PROCESS_DEP_NAMES.map((name) => [name, depStatus(name)])) as Snapshot
}

export function resetV2ProcessStateForTesting(): void {
  processRecords.clear()
  for (const name of PROCESS_DEP_NAMES) startedCounts[name] = 0
  startupMigrations.clear()
  activeV2Runtimes.clear()
}

function withAutoUpdateCheckerDisabled(validation: PluginConfigValidation): PluginConfigValidation {
  const disabledHooks = new Set(validation.config.disabled_hooks ?? [])
  disabledHooks.add("auto-update-checker")
  return { ...validation, config: { ...validation.config, disabled_hooks: [...disabledHooks] } }
}

export function createRuntimeDeps(
  overrides: Partial<PluginModuleDeps> = {},
  input: {
    readonly pluginList?: readonly V2ListedPlugin[]
    readonly sideEffects?: Partial<V2EngineSideEffects>
    readonly tracker?: V2RuntimeTracker
  } = {},
): V2EngineOverrideDeps {
  const sideEffects: V2EngineSideEffects = { ...defaultV2EngineSideEffects, ...input.sideEffects }
  const tracker: V2RuntimeTracker = input.tracker ?? { releasedDeps: new Set(), sharedHandles: [] }
  const detectors = createV2PluginDetectors(input.pluginList ?? [])
  const d9: Pick<PluginModuleDeps, V2EngineOverrideKey> = {
    installAgentSortShim: () => {},
    injectServerAuthIntoClient: () => {},
    initLiveServerRoute: () => {},
    setLiveParentWakeRoutingDisabled: () => {},
    warmLiveServerProbe: () => {},
    ensureTuiPluginEntry: () => ({ changed: false, reason: "opencode-2 host owns the tui plugin entry" }),
    detectDuplicateOmoPlugin: detectors.detectDuplicateOmoPlugin,
    detectExternalSkillPlugin: detectors.detectExternalSkillPlugin,
    loadConfigChain: (directory, environment) =>
      withAutoUpdateCheckerDisabled(sideEffects.loadConfigChain(directory, environment)),
    log: (message: string, data?: unknown) => {
      defaultEngineLog(message, data)
      console.log(message)
    },
    startOmoProcessSweep: () => {
      tracker.releasedDeps.add("sweep")
      return acquireRecord("sweep", sideEffects.startOmoProcessSweep).promise as Promise<void>
    },
    recordPluginTelemetry: (telemetryInput) => {
      tracker.releasedDeps.add("telemetry")
      acquireRecord("telemetry", () => {
        sideEffects.recordPluginTelemetry(telemetryInput)
        return Promise.resolve()
      })
    },
    initializeOpenClaw: async (openclawConfig) => {
      tracker.releasedDeps.add("openclaw")
      await acquireRecord("openclaw", () => sideEffects.initializeOpenClaw(openclawConfig)).promise
    },
    runOpenCodeStartupMigration: (migrationOptions) => {
      const existing = startupMigrations.get(migrationOptions.cwd)
      if (existing !== undefined) return existing
      const result = sideEffects.runOpenCodeStartupMigration(migrationOptions)
      startupMigrations.set(migrationOptions.cwd, result)
      return result
    },
    createRuntimeSkillSourceServer: async (skillOptions) => {
      const record = acquireRecord("skillSource", () => sideEffects.createRuntimeSkillSourceServer(skillOptions))
      const server = (await record.promise) as V2SkillSourceServer
      if (record.disposers.length === 0) record.disposers.push(() => server.stop())
      let handleReleased = false
      const release = async (): Promise<void> => {
        if (handleReleased) return
        handleReleased = true
        await releaseV2ProcessDep("skillSource")
      }
      tracker.sharedHandles.push({ release })
      return {
        url: server.url,
        fetch: (request: Request) => server.fetch(request),
        stop: () => void release(),
      }
    },
  }
  return Object.assign(d9, overrides)
}
