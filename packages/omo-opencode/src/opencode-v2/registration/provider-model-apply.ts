// The plan-contribution appliers of the provider and model registration
// (task 28). The provider applier adds or merges each plan.provider entry
// with the editor.add({ info, models }) shape; the model applier writes the
// expressible overrides onto present models, disables the whitelist and
// blacklist restrictions and applies the plan.model default. Every built item
// passes the completeness guard BEFORE it reaches the host editor: an invalid
// entry is skipped and reported through the LIM-21 unsupported-entry
// reporter, so the host never sees a partial Model.Info / Provider.Info (the
// host reads time.released in its model sort and crashes on entries without
// it). The record converters build the task-22 snapshot values from the
// pre-edit editor state.

import type {
  ModelRestrictionEditor,
  ProviderRegistrationEditor,
  RegisteredModelInfo,
  RegisteredProviderInfo,
} from "./provider-model"
import {
  asRecord,
  asString,
  asStringRecord,
  buildModelMirror,
  buildProviderMirror,
  defaultModelRef,
  isExpressibleModelEntry,
  modelEntriesOf,
  restrictionIdsOf,
  writeModelMirrorFields,
} from "./provider-model-contributions"
import { isValidModelInfo, isValidProviderInfo } from "./provider-model-validate"
import type { RegistrationPlan } from "./registration-plan"
import type {
  ModelSnapshotValue,
  ProviderSnapshotValue,
  SnapshotModelRecord,
  SnapshotProviderRecord,
} from "./snapshot-inputs"

// One string per skipped entry ("providerID/modelID", or the bare providerID
// for a provider-level entry); the reporter dedupes and logs.
export type UnsupportedReporter = (entry: string) => void

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

// Merging onto an existing host provider writes ONLY the fields the V1 entry
// expresses: the host item already carries its own required package and
// activation (its package routes the requests), and overwriting them with the
// V1 defaults would cut every model of that provider off its route.
function mergeProviderSettings(target: RegisteredProviderInfo, providerID: string, entry: unknown): void {
  const record = asRecord(entry)
  target.name = asString(record["name"]) ?? providerID
  const npm = asString(record["npm"])
  if (npm !== undefined) target.package = npm
  const options = asRecord(record["options"])
  if (Object.keys(options).length > 0) Object.assign(target, { settings: { ...options } })
  const headers = asStringRecord(options["headers"])
  if (headers !== undefined) target.headers = headers
}

export function applyProviderContributions(
  editor: ProviderRegistrationEditor,
  providerSection: Readonly<Record<string, unknown>> | undefined,
  reportUnsupported: UnsupportedReporter,
): void {
  if (providerSection === undefined) return
  for (const [providerID, entry] of Object.entries(providerSection)) {
    const built: Array<{
      readonly modelID: string
      readonly entry: unknown
      readonly mirror: RegisteredModelInfo
    }> = []
    for (const [modelID, modelEntry] of modelEntriesOf(entry)) {
      if (!isExpressibleModelEntry(modelEntry)) {
        reportUnsupported(`${providerID}/${modelID}`)
        continue
      }
      const mirror = buildModelMirror(providerID, modelID, modelEntry)
      if (!isValidModelInfo(mirror)) {
        reportUnsupported(`${providerID}/${modelID}`)
        continue
      }
      built.push({ modelID, entry: modelEntry, mirror })
    }
    const mirror = buildProviderMirror(providerID, entry)
    if (!isValidProviderInfo(mirror)) {
      reportUnsupported(providerID)
      continue
    }
    const existing = editor.get(providerID)
    if (existing === undefined) {
      editor.add({ info: mirror, models: built.map((model) => model.mirror) })
      continue
    }
    editor.update(providerID, (provider) => mergeProviderSettings(provider, providerID, entry))
    if (built.length === 0) continue
    // Present host models keep their host-owned fields: the expressible V1
    // fields are written onto them, and only model ids the host does not list
    // yet receive the built complete mirror.
    const appended: RegisteredModelInfo[] = []
    for (const model of built) {
      if (existing.models.has(model.modelID)) {
        editor.models.update(providerID, model.modelID, (target) => writeModelMirrorFields(target, model.entry))
      } else {
        appended.push(model.mirror)
      }
    }
    if (appended.length === 0) continue
    editor.models.set(providerID, [...existing.models.values(), ...appended])
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
        reportUnsupported(`${providerID}/${modelID}`)
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
