// Provider and model registration (task 28 of the opencode-v2-compat plan):
// registerProviderModelTransforms registers the two host transforms whose
// replay bodies FIRST record the pristine pre-transform state through the
// task-22 snapshot and then apply the plan contributions (the OpenGateway
// provider and the provider-phase settings through editor.add({ info, models }),
// the model restrictions and overrides plus the plan.model default through the
// model editor). The returned pair of recompute steps is registered on the
// task-23 plan source (runtime.planSource.registerStep) so every recompute
// re-applies the contributions; the plan source is the ONLY caller of the
// domain reloads. Replay is idempotent: add when absent, update when present.

import { log } from "../../shared"

import {
  applyModelRestrictionsAndOverrides,
  applyProviderContributions,
  modelStateOf,
  providerRecordsOf,
  type UnsupportedReporter,
} from "./provider-model-apply"
import type { HostStateSnapshot } from "./host-state-snapshot"
import { guardReplayEditor } from "./replay-guard"
import type { RegistrationPlan } from "./registration-plan"

const LOG_MARKER = "[opencode-v2] provider-model"

// Structural mirrors of the pinned node_modules/@opencode/plugin 2.4.1
// editor surfaces (ProviderRecord / ProviderEditor / ModelEditor): plain
// strings instead of the effect-branded schema types, so the real host ctx
// and the fake ctx both satisfy them.
export type RegisteredProviderInfo = {
  readonly id: string
  name: string
  [key: string]: unknown
}

export type RegisteredModelInfo = {
  readonly id: string
  readonly modelID: string
  readonly providerID: string
  name: string
  enabled?: boolean
  limit?: { context: number; output: number }
  capabilities?: { tools?: boolean; input?: string[]; output?: string[] }
  temperature?: boolean
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  [key: string]: unknown
}

export type RegisteredProviderRecord = {
  provider: RegisteredProviderInfo
  models: ReadonlyMap<string, RegisteredModelInfo>
}

export type ProviderRegistrationEditor = {
  list(): readonly RegisteredProviderRecord[]
  get(providerID: string): RegisteredProviderRecord | undefined
  add(input: { info: RegisteredProviderInfo; models: readonly RegisteredModelInfo[] }): void
  update(providerID: string, update: (provider: RegisteredProviderInfo) => void): void
  readonly models: {
    set(providerID: string, models: readonly RegisteredModelInfo[]): void
    update(providerID: string, modelID: string, update: (model: RegisteredModelInfo) => void): void
    remove(providerID: string, modelID: string): void
  }
}

export type ModelRestrictionEditor = {
  list(providerID?: string): readonly RegisteredModelInfo[]
  get(providerID: string, modelID: string): RegisteredModelInfo | undefined
  update(providerID: string, modelID: string, update: (model: RegisteredModelInfo) => void): void
  readonly default: {
    get(): { providerID: string; modelID: string } | undefined
    set(providerID: string, modelID: string): void
  }
}

export type ProviderModelContext = {
  readonly provider: {
    readonly transform: (callback: (editor: ProviderRegistrationEditor) => void) => Promise<unknown>
  }
  readonly model: {
    readonly transform: (callback: (editor: ModelRestrictionEditor) => void) => Promise<unknown>
  }
}

// The plan-source step shape tasks 24 to 28 register through
// runtime.planSource.registerStep (the narrower run-input stays assignable).
export type ProviderModelPlanStep = {
  readonly id: string
  readonly domain: "provider" | "model"
  readonly run: (input: { readonly plan?: RegistrationPlan }) => Promise<void>
}

export type ProviderModelRegistrationOptions = {
  // Test and QA seam for the unsupported-entry report; default is one log line
  // per distinct entry through the shared logger.
  readonly onUnsupportedEntry?: (entry: string) => void
}

export async function registerProviderModelTransforms(
  ctx: ProviderModelContext,
  getPlan: () => RegistrationPlan | undefined,
  snapshot: HostStateSnapshot,
  options?: ProviderModelRegistrationOptions,
): Promise<readonly [ProviderModelPlanStep, ProviderModelPlanStep]> {
  const reported = new Set<string>()
  const reportUnsupported: UnsupportedReporter = (providerID, modelID) => {
    const entry = `${providerID}/${modelID}`
    if (reported.has(entry)) return
    reported.add(entry)
    const message = `${LOG_MARKER}: V1 provider model entry ${entry} has no OpenCode 2 model schema counterpart; skipped`
    if (options?.onUnsupportedEntry === undefined) log(message, { entry })
    else options.onUnsupportedEntry(entry)
  }

  const providerReplay = guardReplayEditor("provider-model:provider", (editor: ProviderRegistrationEditor) => {
    snapshot.record({ domain: "provider", value: providerRecordsOf(editor) })
    applyProviderContributions(editor, getPlan()?.provider, reportUnsupported)
    return editor
  })
  const modelReplay = guardReplayEditor("provider-model:model", (editor: ModelRestrictionEditor) => {
    snapshot.record({ domain: "model", value: modelStateOf(editor) })
    applyModelRestrictionsAndOverrides(editor, getPlan(), reportUnsupported)
    return editor
  })

  const providerStep: ProviderModelPlanStep = {
    id: "v2-provider-contributions",
    domain: "provider",
    run: async () => {
      await ctx.provider.transform(providerReplay)
    },
  }
  const modelStep: ProviderModelPlanStep = {
    id: "v2-model-contributions",
    domain: "model",
    run: async () => {
      await ctx.model.transform(modelReplay)
    },
  }
  const steps: readonly [ProviderModelPlanStep, ProviderModelPlanStep] = [providerStep, modelStep]
  for (const step of steps) await step.run({ plan: getPlan() })
  return steps
}
