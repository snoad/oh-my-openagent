// createFakeV2Context: the hermetic OpenCode 2 plugin ctx used by every later V2 test (tasks 12-35 of the
// opencode-v2-compat plan). The ctx shape types live in fake-v2-context-shape.ts (re-exported below); the
// domains come from the per-domain fake modules. Test hooks are prefixed __: __fire, __replay, __sessions,
// __pushEvent, __calls, __storage, __scheduler. __calls records every domain method call as
// "<domain>.<method>" with its arguments.

import { createAgentDomain, createToolDomain } from "./fake-v2-editors"
import { createCommandDomain, createMcpDomain, createSkillDomain } from "./fake-v2-mcp-command-skill-domains"
import { createProviderModelDomains } from "./fake-v2-provider-model-domains"
import { createDefaultScheduler, createEventStream, createHookRegistry } from "./fake-v2-registry"
import { createSessionStore } from "./fake-v2-session-store"
import { createPermissionDomain, createPluginDomain, createShellDomain } from "./fake-v2-support-domains"
import { createRpcDomain, createStorageDomain } from "./fake-v2-rpc-storage-domains"
import type {
  FakeCall,
  FakeEditorDomainName,
  FakeEventDomain,
  FakeReplayValueOf,
  FakeV2Context,
  FakeV2ContextOptions,
} from "./fake-v2-context-shape"
import type { FakeJsonValue } from "./fake-v2-rpc-storage-domains"

export type * from "./fake-v2-context-shape"

function recordDomainMethods<TDomain extends object>(domain: TDomain, domainName: string, calls: FakeCall[]): TDomain {
  const wrapped: Record<string, unknown> = {}
  for (const [method, value] of Object.entries(domain)) {
    wrapped[method] =
      typeof value !== "function"
        ? value
        : (...args: unknown[]) => {
            calls.push({ op: `${domainName}.${method}`, args })
            return (value as (...fnArgs: unknown[]) => unknown)(...args)
          }
  }
  return wrapped as TDomain
}

export function createFakeV2Context(options?: FakeV2ContextOptions): FakeV2Context {
  const scheduler = options?.scheduler ?? createDefaultScheduler()
  const calls: FakeCall[] = []
  const storage = new Map<string, FakeJsonValue>()
  const registry = createHookRegistry()
  const stream = createEventStream()
  const app = options?.app ?? { name: "opencode", version: "2.4.1", channel: "stable" }
  const location = options?.location ?? {
    directory: "/tmp/fake-v2",
    project: { id: "prj_fake", directory: "/tmp/fake-v2", canonical: "/tmp/fake-v2" },
  }
  const sessionStore = createSessionStore({
    registry,
    scheduler,
    locationDirectory: location.directory,
    projectID: location.project.id,
  })
  const agent = createAgentDomain({ registry, directory: location.directory, agents: options?.agents })
  const tool = createToolDomain({ registry, tools: options?.tools })
  const mcp = createMcpDomain({ registry, directory: location.directory })
  const command = createCommandDomain({ registry, directory: location.directory })
  const skill = createSkillDomain({ registry, directory: location.directory })
  const { provider, model } = createProviderModelDomains({ registry, directory: location.directory })
  const freshEditors: { readonly [D in FakeEditorDomainName]: () => FakeReplayValueOf[D] } = {
    agent: agent.freshEditor,
    tool: tool.freshEditor,
    mcp: mcp.freshEditor,
    command: command.freshEditor,
    provider: provider.freshEditor,
    model: model.freshEditor,
    skill: skill.freshEditor,
  }
  const eventDomain: FakeEventDomain = { subscribe: (subscribeOptions) => stream.subscribe(subscribeOptions) }
  return {
    app,
    location,
    options: options?.pluginOptions ?? {},
    agent: recordDomainMethods(agent.domain, "agent", calls),
    tool: recordDomainMethods(tool.domain, "tool", calls),
    mcp: recordDomainMethods(mcp.domain, "mcp", calls),
    command: recordDomainMethods(command.domain, "command", calls),
    provider: recordDomainMethods(provider.domain, "provider", calls),
    model: recordDomainMethods(model.domain, "model", calls),
    permission: recordDomainMethods(createPermissionDomain({ registry }), "permission", calls),
    session: recordDomainMethods(sessionStore.domain, "session", calls),
    event: recordDomainMethods(eventDomain, "event", calls),
    plugin: recordDomainMethods(
      createPluginDomain({ directory: location.directory, plugins: options?.plugins }),
      "plugin",
      calls,
    ),
    storage: recordDomainMethods(createStorageDomain(storage), "storage", calls),
    rpc: recordDomainMethods(createRpcDomain({ registry, stream }), "rpc", calls),
    skill: recordDomainMethods(skill.domain, "skill", calls),
    shell: recordDomainMethods(createShellDomain({ registry }), "shell", calls),
    __fire: (domain, name, event, fireOptions) => registry.fire(domain, name, event, fireOptions),
    __replay: (domain) => registry.replayTransforms(domain, freshEditors[domain]()),
    __sessions: sessionStore.sessions,
    __pushEvent: (event) => stream.push(event),
    __calls: calls,
    __storage: storage,
    __scheduler: scheduler,
  }
}
