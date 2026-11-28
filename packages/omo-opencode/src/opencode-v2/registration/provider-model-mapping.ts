// V2 provider and model state -> V1 provider map and default model (task 22
// of the opencode-v2-compat plan). The provider domain answers provider rows
// without their models on 2.4.1, so the provider map is built from the
// provider source (recorded editor records carry their models, the fallback
// domain list does not) and the model source is then merged in: every model
// becomes a models entry of its provider, keyed by model id, and the default
// selection becomes the V1 "providerID/modelID" string.

import type { SnapshotModelRecord, SnapshotProviderRecord } from "./snapshot-inputs"
import type { ProviderSnapshotValue, SnapshotModelDefault } from "./snapshot-inputs"
import type { V1ConfigProjection } from "./v1-config-projection"

type V1ProviderMap = V1ConfigProjection["provider"]
type V1ProviderConfig = V1ProviderMap[string]
type V1ModelConfig = NonNullable<V1ProviderConfig["models"]>[string]

function modelToV1(model: SnapshotModelRecord): V1ModelConfig {
  return { id: model.modelID, name: model.name }
}

export function providerRecordsToV1(records: ProviderSnapshotValue): V1ProviderMap {
  const map: V1ProviderMap = {}
  for (const record of records) {
    const models: Record<string, V1ModelConfig> = {}
    for (const model of record.models) models[model.modelID] = modelToV1(model)
    map[record.provider.id] = { name: record.provider.name, models }
  }
  return map
}

export function providerListToV1(providers: ReadonlyArray<SnapshotProviderRecord>): V1ProviderMap {
  return providerRecordsToV1(providers.map((provider) => ({ provider, models: [] })))
}

// Model entries merge into the provider map without erasing models that only
// the provider source carried; same-id models from the model source win.
export function mergeModelsIntoProviders(map: V1ProviderMap, models: ReadonlyArray<SnapshotModelRecord>): void {
  for (const model of models) {
    const existing = map[model.providerID] ?? {}
    const merged = { ...(existing.models ?? {}), [model.modelID]: modelToV1(model) }
    map[model.providerID] = { ...existing, models: merged }
  }
}

export function defaultModelToString(selection: SnapshotModelDefault): string {
  return `${selection.providerID}/${selection.modelID}`
}
