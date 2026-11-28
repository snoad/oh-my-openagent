import type { Hooks } from "@opencode-ai/plugin"

import { createPluginModule } from "../../testing/create-plugin-module"
import type { PluginModuleDeps } from "../../testing/create-plugin-module"
import { createV2ClientShim } from "../client/v2-client-shim"
import type { V1ClientShimSurface } from "../client/v1-client-surface"
import type { V2ShimContext } from "../client/shim-context"
import { v2AdapterRegistrations } from "./adapters"
import { stopV2Runtime, type V2Runtime } from "./stop-v2-runtime"
import {
  activeV2Runtimes,
  createRuntimeDeps,
  defaultV2EngineSideEffects,
  type V2EngineOverrideDeps,
  type V2EngineSideEffects,
  type V2RuntimeTracker,
} from "./v2-runtime-deps"
import type { V2ListedPlugin } from "./v2-plugin-identity"

// startV2Runtime (plan task 13): boots the real V1 engine inside an OpenCode
// 2 host. Builds the task-12 client shim over the OpenCode 2 ctx, resolves
// the plugin list for duplicate detection, merges the D-9 dependency
// overrides under any caller-provided engine deps, starts the engine with
// the location directory and the shim, applies the adapter registrations and
// returns the runtime record. A module-level active-runtime map keyed by
// ctx.location.directory guards double starts: a second setup for the same
// location stops the previous runtime first, which is what a host reload
// does; a different location starts a second engine over the shared
// process-wide dependencies.

export type V2RuntimeContext = {
  readonly location: { readonly directory: string }
  readonly plugin: {
    readonly list: (input?: {
      readonly location?: { readonly directory?: string }
    }) => Promise<{ readonly data: readonly V2ListedPlugin[] }>
  }
}

export type V2RuntimePluginContext = V2RuntimeContext & V2ShimContext

export type V2EngineStartInput = {
  readonly directory: string
  readonly client: V1ClientShimSurface
  readonly serverUrl: undefined
}

export type V2EngineHooks = Hooks & { readonly dispose?: () => Promise<void> }

export type V2EngineServer = (input: V2EngineStartInput, options?: Record<string, unknown>) => Promise<V2EngineHooks>

export type V2EngineModule = {
  readonly id?: string
  readonly server: V2EngineServer
}

export type V2RuntimeDeps = {
  readonly engineFactory?: (overrides: V2EngineOverrideDeps) => V2EngineModule
  readonly engineDeps?: Partial<PluginModuleDeps>
  readonly sideEffects?: Partial<V2EngineSideEffects>
  readonly listPlugins?: (ctx: V2RuntimeContext) => Promise<readonly V2ListedPlugin[]>
}

const defaultEngineFactory: NonNullable<V2RuntimeDeps["engineFactory"]> = (overrides) => {
  const module = createPluginModule(overrides)
  return { id: module.id, server: module.server as unknown as V2EngineServer }
}

async function listPluginsOf(ctx: V2RuntimeContext): Promise<readonly V2ListedPlugin[]> {
  const envelope = await ctx.plugin.list({ location: { directory: ctx.location.directory } })
  return envelope.data
}

async function startEngine(module: V2EngineModule, ctx: V2RuntimePluginContext): Promise<V2EngineHooks> {
  const shim = createV2ClientShim(ctx)
  return module.server({ directory: ctx.location.directory, client: shim, serverUrl: undefined }, {})
}

export async function startV2Runtime(ctx: V2RuntimePluginContext, deps: V2RuntimeDeps = {}): Promise<V2Runtime> {
  const directory = ctx.location.directory
  const previous = activeV2Runtimes.get(directory)
  if (previous !== undefined) await stopV2Runtime(previous)
  let pluginList: readonly V2ListedPlugin[] = []
  try {
    pluginList = deps.listPlugins !== undefined ? await deps.listPlugins(ctx) : await listPluginsOf(ctx)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.warn(`[opencode-v2] plugin list unavailable, skipping duplicate detection: ${detail}`)
  }
  const tracker: V2RuntimeTracker = { releasedDeps: new Set(), sharedHandles: [] }
  const overrides = createRuntimeDeps(deps.engineDeps ?? {}, {
    pluginList,
    sideEffects: { ...defaultV2EngineSideEffects, ...deps.sideEffects },
    tracker,
  })
  const engineFactory = deps.engineFactory ?? defaultEngineFactory
  const engine = await startEngine(engineFactory(overrides), ctx)
  const runtime: V2Runtime = {
    directory,
    engine,
    tracker,
    abort: new AbortController(),
    subscriptions: [],
    stopped: false,
    stop: () => stopV2Runtime(runtime),
  }
  activeV2Runtimes.set(directory, runtime)
  for (const registration of v2AdapterRegistrations) {
    await registration.register({ ctx, runtime })
  }
  // The plugin reports active only after the plan source drained its startup
  // recompute chain to a fixed point: a mid-boot config change arms a
  // debounced recompute that would otherwise land after setup returned, and
  // the first admitted session then reads a mid-settlement plan (CI run
  // 46070504361: the first session's request missed the patch and task tools
  // until a later recompute settled the chain).
  if (runtime.planSource !== undefined) await runtime.planSource.settle()
  return runtime
}
