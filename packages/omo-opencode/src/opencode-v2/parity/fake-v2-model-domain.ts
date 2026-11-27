// Model editor domain for the fake OpenCode 2 plugin context, split out of
// fake-v2-provider-model-domains.ts for the 200-line file budget (task 28).
// Local structural mirror of the pinned node_modules/@opencode/plugin 2.4.1
// ModelEditor: the editor owns model overrides and the default selection, and
// its update consults the provider records exactly like get, so overrides and
// restrictions land on provider-contributed models as they do on the host.

import type { FakeListEnvelope, FakeLocationRef } from "./fake-v2-editors"
import type { FakeHookRegistry, FakeRegistration } from "./fake-v2-registry"
import type { FakeModelInfo, FakeProviderRecord, ProviderStores } from "./fake-v2-provider-model-domains"

export type FakeModelEditor = {
  list(providerID?: string): FakeModelInfo[]
  get(providerID: string, modelID: string): FakeModelInfo | undefined
  update(providerID: string, modelID: string, update: (model: FakeModelInfo) => void): void
  remove(providerID: string, modelID: string): void
  readonly default: {
    get(): { providerID: string; modelID: string } | undefined
    set(providerID: string, modelID: string): void
  }
  readonly provider: { list(): FakeProviderRecord[]; get(providerID: string): FakeProviderRecord | undefined }
}

export interface FakeModelDomain {
  list(input?: { readonly location?: { readonly directory?: string } }): Promise<FakeListEnvelope<FakeModelInfo>>
  default(input?: {
    readonly location?: { readonly directory?: string }
  }): Promise<{ readonly location: FakeLocationRef; readonly data: FakeModelInfo | null }>
  transform(callback: (editor: FakeModelEditor) => void): Promise<FakeRegistration>
  reload(): Promise<void>
}

export function createModelEditor(stores: ProviderStores): FakeModelEditor {
  return {
    list: (providerID?: string) =>
      providerID === undefined
        ? [...stores.models]
        : [
            ...(stores.records.get(providerID)?.models.values() ?? []),
            ...stores.models.filter((m) => m.providerID === providerID),
          ],
    get: (providerID, modelID) =>
      stores.models.find((model) => model.providerID === providerID && model.modelID === modelID) ??
      stores.records.get(providerID)?.models.get(modelID),
    update: (providerID, modelID, update) => {
      const model = stores.models.find((c) => c.providerID === providerID && c.modelID === modelID)
      if (model) {
        update(model)
        return
      }
      const fromRecord = stores.records.get(providerID)?.models.get(modelID)
      if (fromRecord) update(fromRecord)
    },
    remove: (providerID, modelID) => {
      const index = stores.models.findIndex((model) => model.providerID === providerID && model.modelID === modelID)
      if (index >= 0) stores.models.splice(index, 1)
    },
    default: {
      get: () => stores.defaultModel,
      set: (providerID, modelID) => {
        stores.defaultModel = { providerID, modelID }
      },
    },
    provider: {
      list: () => [...stores.records.values()],
      get: (providerID) => stores.records.get(providerID),
    },
  }
}
