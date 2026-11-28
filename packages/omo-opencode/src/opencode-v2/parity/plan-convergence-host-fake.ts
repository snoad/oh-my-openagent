// Host-mimicking domain overrides for the registration convergence test.
// The parity fake keeps live mutations and never replays them on reload,
// which is exactly where it diverges from the real OpenCode 2 host and why
// the reload loop never reproduced hermetically. These overrides rebuild the
// registration domains over a fake context with the two host behaviors the
// live capture proved (run 2026-11-27T23:51Z):
// 1. a transform REGISTRATION fires the callback once over the live editor,
//    so every recompute hands the plugin its own previous output;
// 2. a reload fires every registered callback over the REBUILT view, where
//    the host presents created agents under their canonical id while the
//    live editor keeps the display-key id it persisted them under.
// With a recorder that filters its own output by id alone this alternation
// flips the recorded pristine base between poisoned and clean every round,
// which is the observed endless reload cycle.

import {
  createKeyedEditor,
  type FakeAgentDomain,
  type FakeAgentEditor,
  type FakeAgentInfo,
  type FakeToolDomain,
  type FakeToolEditor,
  type FakeToolInfo,
} from "./fake-v2-editors"
import type { FakeRegistration } from "./fake-v2-registry"
import { canonicalAgentKey } from "../registration/agent-v1-to-v2"

const DIRECTORY = "/tmp/oqa-mimic-project"

type DomainHooks<TEditor> = {
  readonly transforms: Array<(editor: TEditor) => void>
  readonly reloads: { count: number }
}

const registrationOf = (): FakeRegistration => ({ dispose: async () => undefined })

function fireAll<TEditor>(hooks: DomainHooks<TEditor>, editor: TEditor): void {
  for (const callback of [...hooks.transforms]) callback(editor)
}

// The live agent registry: an update on a missing id creates the item and
// re-keys it to the display name it now carries (the host form that dodges
// an id-only filter); lookup tolerates either form. With volatileHostFields
// the host agent's name alternates between its display and canonical forms
// on every registry read - the real host's live-mutated vs rebuilt view
// normalization, projection-invisible because the V1 mapping drops the name.
function createAgentOverride(
  seed: ReadonlyArray<FakeAgentInfo>,
  options?: { readonly volatileHostFields?: boolean },
): {
  readonly domain: FakeAgentDomain
  readonly hooks: DomainHooks<FakeAgentEditor>
} {
  const items: FakeAgentInfo[] = seed.map((item) => ({ ...item }))
  const hooks: DomainHooks<FakeAgentEditor> = { transforms: [], reloads: { count: 0 } }
  let defaultAgent: string | undefined
  let readFlip = false
  const volatileName = (name: string): string => {
    readFlip = !readFlip
    return readFlip ? name : name.toLowerCase()
  }
  const find = (id: string): FakeAgentInfo | undefined =>
    items.find((item) => item.id === id) ?? items.find((item) => item.name === id)
  const listItems = (): FakeAgentInfo[] =>
    options?.volatileHostFields === true
      ? items.map((item) => ({ ...item, name: volatileName(String(item.name ?? item.id)) }))
      : items
  const live: FakeAgentEditor = {
    list: listItems,
    get: (id) => find(id),
    add: (agent) => {
      if (find(agent.id) === undefined) items.push({ ...agent })
    },
    update: (id, update) => {
      const item = find(id)
      if (item !== undefined) {
        update(item)
        if (typeof item.name === "string" && item.name !== item.id) item.id = item.name
        return
      }
      const created: FakeAgentInfo = { id, name: id, mode: "subagent", hidden: false }
      items.push(created)
      update(created)
      if (typeof created.name === "string" && created.name !== created.id) created.id = created.name
    },
    remove: (id) => {
      const index = items.findIndex((item) => item.id === id || item.name === id)
      if (index >= 0) items.splice(index, 1)
    },
    default: (id) => {
      defaultAgent = id
    },
    defaultAgent: () => defaultAgent,
  }
  // The rebuilt view: items present their canonical id; writes land live.
  const rebuilt: FakeAgentEditor = {
    list: () => listItems().map((item) => ({ ...item, id: canonicalAgentKey(String(item.id)) })),
    get: (id) => {
      const item = find(id)
      return item === undefined ? undefined : { ...item, id: canonicalAgentKey(item.id) }
    },
    add: live.add,
    update: live.update,
    remove: live.remove,
    default: live.default,
    defaultAgent: live.defaultAgent,
  }
  const domain: FakeAgentDomain = {
    async list() {
      return {
        location: { directory: DIRECTORY },
        data: items.map((item) => ({ ...item, id: canonicalAgentKey(item.id) })),
      }
    },
    async get(input) {
      const item = find(input.agentID)
      if (item === undefined) throw new Error(`mimic: unknown agent ${input.agentID}`)
      return { ...item, id: canonicalAgentKey(item.id) }
    },
    transform: async (callback) => {
      hooks.transforms.push(callback)
      callback(live)
      return registrationOf()
    },
    async reload() {
      hooks.reloads.count += 1
      fireAll(hooks, rebuilt)
    },
  }
  return { domain, hooks }
}

function createToolOverride(
  seed: ReadonlyArray<FakeToolInfo>,
  options?: { readonly volatileHostFields?: boolean },
): {
  readonly domain: FakeToolDomain
  readonly hooks: DomainHooks<FakeToolEditor>
} {
  const namespaces: Array<{ name: string; description?: string }> = []
  const baseEditor = createKeyedEditor([...seed])
  let toolFlip = false
  const editor: FakeToolEditor = {
    ...baseEditor,
    // A host-own tool whose description alternates per registry read (the
    // real host re-normalizes descriptions between its live and rebuilt
    // registries); the plan's tools section carries ids only, so the plan
    // stays byte-identical while the recorded tool base moves every read.
    list: () =>
      options?.volatileHostFields === true
        ? baseEditor.list().map((item) => {
            toolFlip = !toolFlip
            return item.id === "read" ? { ...item, description: toolFlip ? "host read" : "host read (rescan)" } : item
          })
        : baseEditor.list(),
    namespace: (namespace: { name: string; description?: string }) => {
      namespaces.push(namespace)
    },
    appliedNamespaces: () => [...namespaces],
  }
  const hooks: DomainHooks<FakeToolEditor> = { transforms: [], reloads: { count: 0 } }
  const domain: FakeToolDomain = {
    async list() {
      return editor.list()
    },
    transform: async (callback) => {
      hooks.transforms.push(callback)
      callback(editor)
      return registrationOf()
    },
    async reload() {
      hooks.reloads.count += 1
      fireAll(hooks, editor)
    },
    async hook() {
      return registrationOf()
    },
  }
  return { domain, hooks }
}

export { createAgentOverride, createToolOverride }
export type { DomainHooks }
