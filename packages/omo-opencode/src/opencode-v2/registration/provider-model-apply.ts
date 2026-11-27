// The plan-contribution appliers of the provider and model registration
// (task 28). The provider applier adds or merges each plan.provider entry
// with the editor.add({ info, models }) shape; the model applier writes the
// expressible overrides onto present models, disables the whitelist and
// blacklist restrictions and applies the plan.model default. The record
// converters build the task-22 snapshot values from the pre-edit editor
// state.

import type {
  ModelRestrictionEditor,
  ProviderRegistrationEditor,
  RegisteredModelInfo,
  RegisteredProviderInfo,
} from "./provider-model"
import {
  buildModelMirror,
  buildProviderMirror,
  defaultModelRef,
  isExpressibleModelEntry,
  modelEntriesOf,
  restrictionIdsOf,
  writeModelMirrorFields,
  type BuiltProviderMirror,
} from "./provider-model-contributions"
import type { RegistrationPlan } from "./registration-plan"
import type {
  ModelSnapshotValue,
  ProviderSnapshotValue,
  SnapshotModelRecord,
  SnapshotProviderRecord,
} from "./snapshot-inputs"

export type UnsupportedReporter = (providerID: string, modelID: string) => void

function modelSnapshotOf(model: RegisteredModelInfo): SnapshotModelRecord {
  return { id: model.id, modelID: model.modelID, providerID: model.providerID, name: model.name }
}

export function providerRecordsOf(editor: ProviderRegistrationEditor): ProviderSnapshotValue {
  return editor.list().map((record) => {
    const provider: SnapshotProviderRecord = { id: record.provider.id, name: record.provider.name }
    return { provider, models: [...record.models.values()].map(modelSnapshotOf) }
  })
}

export function modelStateOf(editor: ModelRestrictionEditor): ModelSnapshotValue {
  const models = editor.list().map(modelSnapshotOf)
  const selected = editor.default.get()
  return selected === undefined ? { models } : { models, defaultModel: { ...selected } }
}

function mergeProviderSettings(target: RegisteredProviderInfo, mirror: BuiltProviderMirror): void {
  target.name = mirror.name
  for (const [key, value] of Object.entries(mirror)) {
    if (key === "id") continue
    target[key] = value
  }
}

export function applyProviderContributions(
  editor: ProviderRegistrationEditor,
  providerSection: Readonly<Record<string, unknown>> | undefined,
  reportUnsupported: UnsupportedReporter,
): void {
  if (providerSection === undefined) return
  for (const [providerID, entry] of Object.entries(providerSection)) {
    const models = modelEntriesOf(entry)
      .filter(([modelID, modelEntry]) => {
        if (isExpressibleModelEntry(modelEntry)) return true
        reportUnsupported(providerID, modelID)
        return false
      })
      .map(([modelID, modelEntry]) => buildModelMirror(providerID, modelID, modelEntry))
    const mirror = buildProviderMirror(providerID, entry)
    const existing = editor.get(providerID)
    if (existing === undefined) {
      editor.add({ info: mirror, models })
      continue
    }
    editor.update(providerID, (provider) => mergeProviderSettings(provider, mirror))
    if (models.length === 0) continue
    const merged = new Map(existing.models)
    for (const model of models) merged.set(model.id, model)
    editor.models.set(providerID, [...merged.values()])
  }
}

export function applyModelRestrictionsAndOverrides(
  editor: ModelRestrictionEditor,
  plan: RegistrationPlan | undefined,
  reportUnsupported: UnsupportedReporter,
): void {
  for (const [providerID, entry] of Object.entries(plan?.provider ?? {})) {
    for (const [modelID, modelEntry] of modelEntriesOf(entry)) {
      if (!isExpressibleModelEntry(modelEntry)) {
        reportUnsupported(providerID, modelID)
        continue
      }
      if (editor.get(providerID, modelID) === undefined) continue
      editor.update(providerID, modelID, (model) => writeModelMirrorFields(model, modelEntry))
    }
    const { whitelist, blacklist } = restrictionIdsOf(entry)
    for (const model of editor.list(providerID)) {
      const restricted =
        blacklist.includes(model.modelID) || (whitelist.length > 0 && !whitelist.includes(model.modelID))
      if (!restricted) continue
      editor.update(providerID, model.modelID, (target) => {
        target.enabled = false
      })
    }
  }
  const selection = defaultModelRef(plan?.model)
  if (selection !== undefined) editor.default.set(selection.providerID, selection.modelID)
}
