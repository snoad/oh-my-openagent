// Provider and model editor domains for the fake OpenCode 2 plugin context, task 9 of the opencode-v2-compat
// plan. Local structural mirrors of the pinned node_modules/@opencode/plugin 2.4.1 declarations: the provider
// editor owns the provider records (with their model maps), the model editor owns model overrides and the
// default selection, and its provider view reads the same records before model transforms (ModelEditor.provider).

import {
  registerEditorTransform,
  type FakeEditorDomainResult,
  type FakeListEnvelope,
  type FakeLocationRef,
} from "./fake-v2-editors"
import type { FakeHookRegistry, FakeRegistration } from "./fake-v2-registry"

export type FakeProviderInfo = { id: string; name: string; [key: string]: unknown }

export type FakeModelInfo = { id: string; modelID: string; providerID: string; name: string; [key: string]: unknown }

export type FakeProviderRecord = {
  provider: FakeProviderInfo
  models: ReadonlyMap<string, FakeModelInfo>
  sourceConnection?: Record<string, unknown>
}

export type FakeProviderEditor = {
  list(): FakeProviderRecord[]
  get(providerID: string): FakeProviderRecord | undefined
  add(record: {
    info: FakeProviderInfo
    models: ReadonlyArray<FakeModelInfo>
    sourceConnection?: Record<string, unknown>
  }): void
  update(providerID: string, update: (provider: FakeProviderInfo) => void): void
  remove(providerID: string): void
  readonly models: {
    set(providerID: string, models: ReadonlyArray<FakeModelInfo>): void
    update(providerID: string, modelID: string, update: (model: FakeModelInfo) => void): void
    remove(providerID: string, modelID: string): void
  }
}

export interface FakeProviderDomain {
  list(input?: { readonly location?: { readonly directory?: string } }): Promise<FakeListEnvelope<FakeProviderInfo>>
  get(input: { readonly providerID: string }): Promise<FakeProviderInfo>
  transform(callback: (editor: FakeProviderEditor) => void): Promise<FakeRegistration>
  reload(): Promise<void>
}

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

// Store twin of FakeProviderRecord: mutable model map the editor writes through; the public mirror stays ReadonlyMap.
type ProviderStoreRecord = {
  provider: FakeProviderInfo
  models: Map<string, FakeModelInfo>
  sourceConnection?: Record<string, unknown>
}

type ProviderStores = {
  readonly records: Map<string, ProviderStoreRecord>
  readonly models: FakeModelInfo[]
  defaultModel: { providerID: string; modelID: string } | undefined
}

function createProviderStores(): ProviderStores {
  return { records: new Map(), models: [], defaultModel: undefined }
}

function createProviderEditor(stores: ProviderStores): FakeProviderEditor {
  return {
    list: () => [...stores.records.values()],
    get: (providerID: string) => stores.records.get(providerID),
    add: (record) => {
      stores.records.set(record.info.id, {
        provider: record.info,
        models: new Map(record.models.map((model) => [model.id, model])),
        sourceConnection: record.sourceConnection,
      })
    },
    update: (providerID, update) => {
      const record = stores.records.get(providerID)
      if (record) update(record.provider)
    },
    remove: (providerID) => {
      stores.records.delete(providerID)
    },
    models: {
      set: (providerID, models) => {
        const record = stores.records.get(providerID)
        if (record) record.models = new Map(models.map((model) => [model.id, model]))
      },
      update: (providerID, modelID, update) => {
        const model = stores.records.get(providerID)?.models.get(modelID)
        if (model) update(model)
      },
      remove: (providerID, modelID) => {
        stores.records.get(providerID)?.models.delete(modelID)
      },
    },
  }
}

function createModelEditor(stores: ProviderStores): FakeModelEditor {
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
      if (model) update(model)
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

export function createProviderModelDomains(input: {
  readonly registry: FakeHookRegistry
  readonly directory: string
}): {
  readonly provider: FakeEditorDomainResult<FakeProviderDomain, FakeProviderEditor>
  readonly model: FakeEditorDomainResult<FakeModelDomain, FakeModelEditor>
} {
  const live = createProviderStores()
  const providerDomain: FakeProviderDomain = {
    async list() {
      return {
        location: { directory: input.directory },
        data: [...live.records.values()].map((record) => record.provider),
      }
    },
    async get(getInput) {
      const record = live.records.get(getInput.providerID)
      if (!record) throw new Error(`fake v2: unknown provider ${getInput.providerID}`)
      return record.provider
    },
    transform: (callback) => registerEditorTransform(input.registry, "provider", createProviderEditor(live), callback),
    async reload() {},
  }
  const modelDomain: FakeModelDomain = {
    async list() {
      return { location: { directory: input.directory }, data: [...live.models] }
    },
    async default() {
      const selection = live.defaultModel
      const model = selection ? createModelEditor(live).get(selection.providerID, selection.modelID) : undefined
      return { location: { directory: input.directory }, data: model ?? null }
    },
    transform: (callback) => registerEditorTransform(input.registry, "model", createModelEditor(live), callback),
    async reload() {},
  }
  return {
    provider: {
      domain: providerDomain,
      freshEditor: () => createProviderEditor(createProviderStores()),
    },
    model: {
      domain: modelDomain,
      freshEditor: () => createModelEditor(createProviderStores()),
    },
  }
}
