// Provider and model host-mimicking overrides for the registration
// convergence test (split from plan-convergence-host-fake.ts for the
// file-size rule). The provider editor is the plain mirror both the snapshot
// records and the plan contributions read and write; the model editor is the
// fake's own store-backed editor. Same fire semantics as the other override
// domains: a transform registration fires over the live store, a reload
// re-fires every registered callback.

import { createModelEditor, type FakeModelDomain, type FakeModelEditor } from "./fake-v2-model-domain"
import type { ProviderStores } from "./fake-v2-provider-model-domains"
import type { RegisteredModelInfo, RegisteredProviderInfo } from "../registration/provider-model"
import { buildModelMirror } from "../registration/provider-model-contributions"

const DIRECTORY = "/tmp/oqa-mimic-project"

type DomainHooks<TEditor> = {
  readonly transforms: Array<(editor: TEditor) => void>
  readonly reloads: { count: number }
}

function registrationOf(): { readonly dispose: () => Promise<void> } {
  return { dispose: async () => undefined }
}

function fireAll<TEditor>(hooks: DomainHooks<TEditor>, editor: TEditor): void {
  for (const callback of [...hooks.transforms]) callback(editor)
}

type ProviderRecordLite = {
  provider: RegisteredProviderInfo
  models: Map<string, RegisteredModelInfo>
}

type ProviderRecordEditor = {
  list(): ReadonlyArray<{ provider: RegisteredProviderInfo; models: ReadonlyMap<string, RegisteredModelInfo> }>
  get(
    providerID: string,
  ): { provider: RegisteredProviderInfo; models: ReadonlyMap<string, RegisteredModelInfo> } | undefined
  add(input: { info: RegisteredProviderInfo; models: ReadonlyArray<RegisteredModelInfo> }): void
  update(providerID: string, update: (provider: RegisteredProviderInfo) => void): void
  readonly models: {
    set(providerID: string, models: ReadonlyArray<RegisteredModelInfo>): void
    update(providerID: string, modelID: string, update: (model: RegisteredModelInfo) => void): void
    remove(providerID: string, modelID: string): void
  }
}

function providerEditorOf(stores: ProviderStores): ProviderRecordEditor {
  const recordOf = (providerID: string): ProviderRecordLite | undefined => stores.records.get(providerID)
  const viewOf = (record: ProviderRecordLite) => ({ provider: record.provider, models: record.models })
  return {
    list: () => [...stores.records.values()].map(viewOf),
    get: (providerID) => {
      const record = recordOf(providerID)
      return record === undefined ? undefined : viewOf(record)
    },
    add: (input) => {
      stores.records.set(input.info.id, {
        provider: { ...input.info },
        models: new Map(input.models.map((model) => [model.id, model])),
      })
    },
    update: (providerID, update) => {
      const record = recordOf(providerID)
      if (record !== undefined) update(record.provider)
    },
    models: {
      set: (providerID, models) => {
        const record = recordOf(providerID)
        if (record !== undefined) record.models = new Map(models.map((model) => [model.id, model]))
      },
      update: (providerID, modelID, update) => {
        const model = recordOf(providerID)?.models.get(modelID)
        if (model !== undefined) update(model)
      },
      remove: (providerID, modelID) => {
        recordOf(providerID)?.models.delete(modelID)
      },
    },
  }
}

function seedHostModels(): RegisteredModelInfo[] {
  return [buildModelMirror("opencode", "big-pickle", {}), buildModelMirror("opencode", "gpt-fake", {})]
}

export function createProviderModelOverrides(seed: ReadonlyArray<RegisteredModelInfo>): {
  readonly provider: {
    readonly list: () => Promise<{ readonly data: ReadonlyArray<{ id: string; name: string }> }>
    readonly transform: (callback: (editor: ProviderRecordEditor) => void) => Promise<unknown>
    readonly reload: () => Promise<void>
  }
  readonly model: Pick<FakeModelDomain, "transform" | "reload" | "list" | "default">
} {
  const stores: ProviderStores = { records: new Map(), models: [...seed], defaultModel: undefined }
  const modelEditor: FakeModelEditor = createModelEditor(stores)
  const providerHooks: DomainHooks<ProviderRecordEditor> = { transforms: [], reloads: { count: 0 } }
  const modelHooks: DomainHooks<FakeModelEditor> = { transforms: [], reloads: { count: 0 } }
  return {
    provider: {
      list: async () => ({
        location: { directory: DIRECTORY },
        data: [...stores.records.values()].map((record) => ({
          id: record.provider.id,
          name: record.provider.name,
        })),
      }),
      transform: async (callback) => {
        providerHooks.transforms.push(callback)
        callback(providerEditorOf(stores))
        return registrationOf()
      },
      reload: async () => {
        providerHooks.reloads.count += 1
        fireAll(providerHooks, providerEditorOf(stores))
      },
    },
    model: {
      transform: async (callback) => {
        modelHooks.transforms.push(callback)
        callback(modelEditor)
        return registrationOf()
      },
      reload: async () => {
        modelHooks.reloads.count += 1
        fireAll(modelHooks, modelEditor)
      },
      list: async () => ({ location: { directory: DIRECTORY }, data: [...stores.models] }),
      default: async () => {
        const selection = stores.defaultModel
        const model = selection === undefined ? undefined : modelEditor.get(selection.providerID, selection.modelID)
        return { location: { directory: DIRECTORY }, data: model ?? null }
      },
    },
  }
}

export { seedHostModels }
