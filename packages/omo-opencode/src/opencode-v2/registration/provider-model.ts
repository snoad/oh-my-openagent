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
// The editor mirrors are the REAL pinned SDK item types (MutableModelInfo /
// MutableProviderInfo over @opencode/plugin): a hand-written optional-field
// mirror cannot catch a missing required field at compile time, which is how
// the incomplete Model.Info entries reached the host in the first place.

import { log } from "../../shared"

import {
  applyModelRestrictionsAndOverrides,
  applyProviderContributions,
  modelStateOf,
  providerRecordsOf,
  type UnsupportedReporter,
} from "./provider-model-apply"
import type { HostStateSnapshot } from "./host-state-snapshot"
import type { MutableModelInfo, MutableProviderInfo } from "./provider-model-info"
import { guardReplayEditor } from "./replay-guard"
import type { RegistrationPlan } from "./registration-plan"

const LOG_MARKER = "[opencode-v2] provider-model"

// The mutable item views the host editors hand to update callbacks (the
// pinned 2.4.1 editors use Types.DeepMutable over the schema items).
export type RegisteredProviderInfo = MutableProviderInfo
export type RegisteredModelInfo = MutableModelInfo

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
  readonly run: (input: { readonly plan?: RegistrationPlan; readonly apply: boolean }) => Promise<void>
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
  const reportUnsupported: UnsupportedReporter = (entry) => {
    if (reported.has(entry)) return
    reported.add(entry)
    const message = `${LOG_MARKER}: V1 provider entry ${entry} has no complete OpenCode 2 item counterpart; skipped`
    if (options?.onUnsupportedEntry === undefined) log(message, { entry })
    else options.onUnsupportedEntry(entry)
  }

  // The replays no longer record the editor state into the snapshot: the
  // provider and model editors list the whole models.dev catalog (329
  // providers / 9218 models on the live host), while the task-22 base mirrors
  // the V1 CONFIG surface (ctx.provider.list() and ctx.model.list()), and a
  // catalog-recorded base made every plan carry the full catalog so the apply
  // rewrote thousands of model mirrors per reload, blocking the host event
  // loop (the wave-3 run-b CLI timeout). The API fallback read in the
  // snapshot is the correct pristine base for both domains and reflects
  // foreign host changes directly.
  const providerReplay = guardReplayEditor("provider-model:provider", (editor: ProviderRegistrationEditor) => {
    applyProviderContributions(editor, getPlan()?.provider, reportUnsupported)
    return editor
  })
  const modelReplay = guardReplayEditor("provider-model:model", (editor: ModelRestrictionEditor) => {
    applyModelRestrictionsAndOverrides(editor, getPlan(), reportUnsupported)
    return editor
  })

  const providerStep: ProviderModelPlanStep = {
    id: "v2-provider-contributions",
    domain: "provider",
    run: async (input) => {
      if (input.apply !== true) return
      await ctx.provider.transform(providerReplay)
    },
  }
  const modelStep: ProviderModelPlanStep = {
    id: "v2-model-contributions",
    domain: "model",
    run: async (input) => {
      if (input.apply !== true) return
      await ctx.model.transform(modelReplay)
    },
  }
  const steps: readonly [ProviderModelPlanStep, ProviderModelPlanStep] = [providerStep, modelStep]
  for (const step of steps) await step.run({ plan: getPlan(), apply: true })
  return steps
}
