// MCP, command and skill editor domains for the fake OpenCode 2 plugin
// context, task 9 of the opencode-v2-compat plan. Local structural mirrors of
// the pinned node_modules/@opencode/plugin 2.4.1 declarations (the SDK
// editors expose effect-branded schema types that cannot be constructed
// without the schema runtime). MCP is keyed by server name; the command editor
// is add-only like the SDK CommandEditor; the skill editor is keyed by id.

import { createKeyedEditor, registerEditorTransform, type FakeEditorDomainResult, type FakeListEnvelope } from "./fake-v2-editors"
import type { FakeHookRegistry, FakeRegistration } from "./fake-v2-registry"

type KeyedEditor = ReturnType<typeof createKeyedEditor<FakeSkillInfo>>

export type FakeMcpServerConfig = Record<string, unknown>

export type FakeMcpEditor = {
  list(): Array<[string, FakeMcpServerConfig]>
  get(name: string): FakeMcpServerConfig | undefined
  set(name: string, config: FakeMcpServerConfig): void
  update(name: string, update: (config: FakeMcpServerConfig) => void): void
  remove(name: string): void
}

export interface FakeMcpDomain {
  list(input?: { readonly location?: { readonly directory?: string } }): Promise<FakeListEnvelope<FakeMcpServerConfig>>
  transform(callback: (editor: FakeMcpEditor) => void): Promise<FakeRegistration>
  reload(): Promise<void>
}

export type FakeCommandDefinition = {
  name: string
  description?: string
  execute: (input: { sessionID: string; prompt: { text: string }; delivery: "steer" | "queue" }) => Promise<void>
}

export type FakeCommandEditor = {
  add(definition: FakeCommandDefinition): void
}

export interface FakeCommandDomain {
  list(input?: { readonly location?: { readonly directory?: string } }): Promise<FakeListEnvelope<FakeCommandDefinition>>
  transform(callback: (editor: FakeCommandEditor) => void): Promise<FakeRegistration>
  reload(): Promise<void>
}

export type FakeSkillInfo = {
  id: string
  name: string
  description?: string
  autoinvoke?: boolean
  path: string
  content: string
}

export type FakeSkillEditor = {
  list(): FakeSkillInfo[]
  get(id: string): FakeSkillInfo | undefined
  add(skill: FakeSkillInfo): void
  update(id: string, update: (skill: FakeSkillInfo) => void): void
  remove(id: string): void
}

export interface FakeSkillDomain {
  list(input?: { readonly location?: { readonly directory?: string } }): Promise<FakeListEnvelope<FakeSkillInfo>>
  transform(callback: (editor: FakeSkillEditor) => void): Promise<FakeRegistration>
  reload(): Promise<void>
}

export function createMcpDomain(input: {
  readonly registry: FakeHookRegistry
  readonly directory: string
}): FakeEditorDomainResult<FakeMcpDomain, FakeMcpEditor> {
  const buildEditor = (): FakeMcpEditor => {
    const servers = new Map<string, FakeMcpServerConfig>()
    return {
      list: () => [...servers.entries()],
      get: (name: string) => servers.get(name),
      set: (name: string, config: FakeMcpServerConfig) => {
        servers.set(name, config)
      },
      update: (name: string, update: (config: FakeMcpServerConfig) => void) => {
        const config = servers.get(name)
        if (config) update(config)
      },
      remove: (name: string) => {
        servers.delete(name)
      },
    }
  }
  const live = buildEditor()
  const domain: FakeMcpDomain = {
    async list() {
      return {
        location: { directory: input.directory },
        data: live.list().map(([name]) => ({ name, status: "connected" })),
      }
    },
    transform: (callback) => registerEditorTransform(input.registry, "mcp", live, callback),
    async reload() {},
  }
  return { domain, freshEditor: buildEditor }
}

export function createCommandDomain(input: {
  readonly registry: FakeHookRegistry
  readonly directory: string
}): FakeEditorDomainResult<FakeCommandDomain, FakeCommandEditor & { definitions(): FakeCommandDefinition[] }> {
  const buildEditor = (): FakeCommandEditor & { definitions(): FakeCommandDefinition[] } => {
    const definitions: FakeCommandDefinition[] = []
    return {
      add: (definition: FakeCommandDefinition) => {
        definitions.push(definition)
      },
      definitions: () => definitions,
    }
  }
  const live = buildEditor()
  const domain: FakeCommandDomain = {
    async list() {
      return { location: { directory: input.directory }, data: live.definitions() }
    },
    transform: (callback) => registerEditorTransform(input.registry, "command", live, callback),
    async reload() {},
  }
  return { domain, freshEditor: buildEditor }
}

export function createSkillDomain(input: {
  readonly registry: FakeHookRegistry
  readonly directory: string
}): FakeEditorDomainResult<FakeSkillDomain, FakeSkillEditor> {
  const buildEditor = (): FakeSkillEditor => createKeyedEditor<FakeSkillInfo>([])
  const live = buildEditor()
  const domain: FakeSkillDomain = {
    async list() {
      return { location: { directory: input.directory }, data: live.list() }
    },
    transform: (callback) => registerEditorTransform(input.registry, "skill", live, callback),
    async reload() {},
  }
  return { domain, freshEditor: buildEditor }
}
