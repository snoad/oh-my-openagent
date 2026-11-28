// MCP and command host-mimicking overrides for the registration convergence
// test (split from plan-convergence-host-fake.ts for the file-size rule).
// Same fire semantics as the other override domains: a transform registration
// fires over the live registry, a reload re-fires every registered callback;
// neither domain needs the agent id-form quirk, so both registries are plain
// live maps that keep the plugin's previous output visible to every replay.

import type {
  FakeCommandDefinition,
  FakeCommandDomain,
  FakeCommandEditor,
  FakeMcpDomain,
  FakeMcpEditor,
  FakeMcpServerConfig,
} from "./fake-v2-mcp-command-skill-domains"
import type { FakeRegistration } from "./fake-v2-registry"
import type { DomainHooks } from "./plan-convergence-host-fake"

const DIRECTORY = "/tmp/oqa-mimic-project"

function registrationOf(): FakeRegistration {
  return { dispose: async () => undefined }
}

function fireAll<TEditor>(hooks: DomainHooks<TEditor>, editor: TEditor): void {
  for (const callback of [...hooks.transforms]) callback(editor)
}

export function createMcpOverride(): {
  readonly domain: FakeMcpDomain
  readonly hooks: DomainHooks<FakeMcpEditor>
} {
  const configs = new Map<string, FakeMcpServerConfig>()
  const editor: FakeMcpEditor = {
    list: () => [...configs.entries()],
    get: (name) => configs.get(name),
    set: (name, config) => {
      configs.set(name, config)
    },
    update: (name, update) => {
      const config = configs.get(name)
      if (config !== undefined) update(config)
    },
    remove: (name) => {
      configs.delete(name)
    },
  }
  const hooks: DomainHooks<FakeMcpEditor> = { transforms: [], reloads: { count: 0 } }
  const domain: FakeMcpDomain = {
    async list() {
      return {
        location: { directory: DIRECTORY },
        data: [...configs.keys()].map((name) => ({ name, status: "connected" })),
      }
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
  }
  return { domain, hooks }
}

export function createCommandOverride(seed: ReadonlyArray<FakeCommandDefinition>): {
  readonly domain: FakeCommandDomain
  readonly hooks: DomainHooks<FakeCommandEditor>
} {
  const definitions: FakeCommandDefinition[] = [...seed]
  const editor: FakeCommandEditor = {
    add: (definition) => {
      definitions.push(definition)
    },
  }
  const hooks: DomainHooks<FakeCommandEditor> = { transforms: [], reloads: { count: 0 } }
  const domain: FakeCommandDomain = {
    async list() {
      return { location: { directory: DIRECTORY }, data: [...definitions] }
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
  }
  return { domain, hooks }
}
