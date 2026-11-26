// Fixture-backed editor domains (agent, tool) plus the shared editor
// substrate for the fake OpenCode 2 plugin context, task 9 of the
// opencode-v2-compat plan. Editor surfaces mirror the pinned
// node_modules/@opencode/plugin 2.4.1 declarations with local structural types
// (the SDK editors expose effect-branded schema types that cannot be
// constructed without the schema runtime). ctx.tool.list serves the recorded
// host-2.4.1 fixture JSON (id + JSON Schema parameters); the real host's
// tool.input is a schema-builder function, so the fixtures carry the JSON
// Schema form of the session context hook payload instead.

import agentsFixture from "./fixtures/host-2.4.1/agents.json"
import toolsFixture from "./fixtures/host-2.4.1/tools.json"
import type { FakeHookRegistry, FakeRegistration } from "./fake-v2-registry"

export type FakeLocationRef = { readonly directory: string }

export type FakeListEnvelope<T> = { readonly location: FakeLocationRef; readonly data: T[] }

export type FakeAgentInfo = {
  id: string
  name: string
  mode: "subagent" | "primary" | "all"
  hidden: boolean
  description?: string
  permissions?: ReadonlyArray<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>
  request?: Record<string, unknown>
}

export type FakeAgentEditor = {
  list(): FakeAgentInfo[]
  get(id: string): FakeAgentInfo | undefined
  add(agent: FakeAgentInfo): void
  update(id: string, update: (agent: FakeAgentInfo) => void): void
  remove(id: string): void
  default(id: string | undefined): void
  defaultAgent(): string | undefined
}

export interface FakeAgentDomain {
  list(input?: { readonly location?: { readonly directory?: string } }): Promise<FakeListEnvelope<FakeAgentInfo>>
  get(input: { readonly agentID: string }): Promise<FakeAgentInfo>
  transform(callback: (editor: FakeAgentEditor) => void): Promise<FakeRegistration>
  reload(): Promise<void>
}

export type FakeToolInfo = {
  id: string
  description?: string
  parameters?: Record<string, unknown>
}

export type FakeToolEditor = {
  list(): FakeToolInfo[]
  get(id: string): FakeToolInfo | undefined
  add(tool: FakeToolInfo): void
  update(id: string, update: (tool: FakeToolInfo) => void): void
  remove(id: string): void
  namespace(namespace: { name: string; description?: string }): void
  appliedNamespaces(): ReadonlyArray<{ name: string; description?: string }>
}

export interface FakeToolDomain {
  list(): Promise<FakeToolInfo[]>
  transform(callback: (editor: FakeToolEditor) => void): Promise<FakeRegistration>
  reload(): Promise<void>
  hook<TEvent extends object>(
    name: string,
    callback: (input: TEvent) => void | Promise<void>,
  ): Promise<FakeRegistration>
}

// The recorded fixture JSON widens its literal unions to string, so the agent
// seed is cast once at this boundary into the local mirror that keeps them.
const agentSeed = agentsFixture.data as ReadonlyArray<FakeAgentInfo>
const toolSeed: ReadonlyArray<FakeToolInfo> = toolsFixture.tools

export function createKeyedEditor<TItem extends { id: string }>(seed: ReadonlyArray<TItem>) {
  const items: TItem[] = seed.map((item) => ({ ...item }))
  return {
    list: () => items,
    get: (id: string) => items.find((item) => item.id === id),
    add: (item: TItem) => {
      items.push(item)
    },
    update: (id: string, update: (item: TItem) => void) => {
      const item = items.find((candidate) => candidate.id === id)
      if (item) update(item)
    },
    remove: (id: string) => {
      const index = items.findIndex((item) => item.id === id)
      if (index >= 0) items.splice(index, 1)
    },
  }
}

export type FakeEditorDomainResult<TDomain, TEditor> = {
  readonly domain: TDomain
  readonly freshEditor: () => TEditor
}

// Registers the transform: applies it to the live editor immediately (so
// domain.list reflects it) and captures it for __replay. dispose removes the
// captured transform; live mutations stay (the host equivalent is a rebuild).
export function registerEditorTransform<TEditor>(
  registry: FakeHookRegistry,
  domain: string,
  liveEditor: TEditor,
  callback: (editor: TEditor) => void,
): Promise<FakeRegistration> {
  callback(liveEditor)
  return Promise.resolve(registry.registerTransform(domain, callback))
}

export function createAgentDomain(input: {
  readonly registry: FakeHookRegistry
  readonly directory: string
  readonly agents?: ReadonlyArray<FakeAgentInfo>
}): FakeEditorDomainResult<FakeAgentDomain, FakeAgentEditor> {
  const seed = input.agents ?? agentSeed
  const buildEditor = (): FakeAgentEditor => {
    const keyed = createKeyedEditor(seed)
    let defaultAgent: string | undefined
    return {
      ...keyed,
      default: (id: string | undefined) => {
        defaultAgent = id
      },
      defaultAgent: () => defaultAgent,
    }
  }
  const live = buildEditor()
  const domain: FakeAgentDomain = {
    async list() {
      return { location: { directory: input.directory }, data: live.list() }
    },
    async get(getInput) {
      const agent = live.get(getInput.agentID)
      if (!agent) throw new Error(`fake v2: unknown agent ${getInput.agentID}`)
      return agent
    },
    transform: (callback) => registerEditorTransform(input.registry, "agent", live, callback),
    async reload() {},
  }
  return { domain, freshEditor: buildEditor }
}

export function createToolDomain(input: {
  readonly registry: FakeHookRegistry
  readonly tools?: ReadonlyArray<FakeToolInfo>
}): FakeEditorDomainResult<FakeToolDomain, FakeToolEditor> {
  const seed = input.tools ?? toolSeed
  const buildEditor = (): FakeToolEditor => {
    const keyed = createKeyedEditor(seed)
    const namespaces: Array<{ name: string; description?: string }> = []
    return {
      ...keyed,
      namespace: (namespace: { name: string; description?: string }) => {
        namespaces.push(namespace)
      },
      appliedNamespaces: () => [...namespaces],
    }
  }
  const live = buildEditor()
  const domain: FakeToolDomain = {
    async list() {
      return live.list()
    },
    transform: (callback) => registerEditorTransform(input.registry, "tool", live, callback),
    async reload() {},
    async hook(name, callback) {
      return input.registry.registerHook("tool", name, callback)
    },
  }
  return { domain, freshEditor: buildEditor }
}
