// createFakeV2Context: the hermetic OpenCode 2 plugin ctx used by every later
// V2 test (tasks 12-35 of the opencode-v2-compat plan). Domains mirror the
// pinned node_modules/@opencode/plugin 2.4.1 surface; app and the session
// methods are typed through the sanctioned root type import (they are plain in
// the 2.4.1 client types), the editor and hook payload surfaces are local
// structural mirrors (the SDK ones carry effect-branded schema types). Test
// hooks are prefixed __: __fire, __replay, __sessions, __pushEvent, __calls,
// __storage, __scheduler. __calls records every domain method call as
// "<domain>.<method>" with its arguments.

import type { Plugin } from "@opencode/plugin"

import type { FakeAgentDomain, FakeAgentEditor, FakeAgentInfo, FakeToolDomain, FakeToolEditor, FakeToolInfo } from "./fake-v2-editors"
import { createAgentDomain, createToolDomain } from "./fake-v2-editors"
import type { FakeCommandDefinition, FakeCommandDomain, FakeCommandEditor, FakeMcpDomain, FakeMcpEditor, FakeSkillDomain, FakeSkillEditor } from "./fake-v2-mcp-command-skill-domains"
import { createCommandDomain, createMcpDomain, createSkillDomain } from "./fake-v2-mcp-command-skill-domains"
import type { FakeModelDomain, FakeModelEditor, FakeProviderDomain, FakeProviderEditor } from "./fake-v2-provider-model-domains"
import { createProviderModelDomains } from "./fake-v2-provider-model-domains"
import { createDefaultScheduler, createEventStream, createHookRegistry, type FakeHookOptions, type FakeScheduler, type FakeSubscribeOptions, type FakeV2Event } from "./fake-v2-registry"
import type { FakeSessionDomain, FakeSessionRecord } from "./fake-v2-session-store"
import { createSessionStore } from "./fake-v2-session-store"
import type { FakeJsonValue, FakePermissionDomain, FakePluginDomain, FakePluginInfo, FakeRpcDomain, FakeShellDomain, FakeStorageDomain } from "./fake-v2-support-domains"
import { createPermissionDomain, createPluginDomain, createRpcDomain, createShellDomain, createStorageDomain } from "./fake-v2-support-domains"

export type FakeApp = Plugin.Context["app"]

export type FakeLocation = {
  readonly directory: string
  readonly workspaceID?: string
  readonly project: { readonly id: string; readonly directory: string; readonly canonical: string }
}

export type FakeCall = { readonly op: string; readonly args: readonly unknown[] }

export type FakeHookDomainName = "session" | "tool" | "permission" | "shell"

export type FakeEditorDomainName = "agent" | "tool" | "mcp" | "command" | "provider" | "model" | "skill"

export type FakeReplayValueOf = {
  agent: FakeAgentEditor
  tool: FakeToolEditor
  mcp: FakeMcpEditor
  command: FakeCommandEditor & { definitions(): FakeCommandDefinition[] }
  provider: FakeProviderEditor
  model: FakeModelEditor
  skill: FakeSkillEditor
}

export interface FakeEventDomain {
  subscribe(options?: FakeSubscribeOptions): AsyncIterable<FakeV2Event>
}

export type FakeV2Context = {
  readonly app: FakeApp
  readonly location: FakeLocation
  readonly options: Readonly<Record<string, unknown>>
  readonly agent: FakeAgentDomain
  readonly tool: FakeToolDomain
  readonly mcp: FakeMcpDomain
  readonly command: FakeCommandDomain
  readonly provider: FakeProviderDomain
  readonly model: FakeModelDomain
  readonly permission: FakePermissionDomain
  readonly session: FakeSessionDomain
  readonly event: FakeEventDomain
  readonly plugin: FakePluginDomain
  readonly storage: FakeStorageDomain
  readonly rpc: FakeRpcDomain
  readonly skill: FakeSkillDomain
  readonly shell: FakeShellDomain
  readonly __fire: <TEvent>(domain: FakeHookDomainName, name: string, event: TEvent, options?: FakeHookOptions) => Promise<TEvent>
  readonly __replay: <D extends FakeEditorDomainName>(domain: D) => FakeReplayValueOf[D]
  readonly __sessions: ReadonlyMap<string, FakeSessionRecord>
  readonly __pushEvent: (event: FakeV2Event) => void
  readonly __calls: readonly FakeCall[]
  readonly __storage: ReadonlyMap<string, FakeJsonValue>
  readonly __scheduler: FakeScheduler
}

export type FakeV2ContextOptions = {
  readonly app?: FakeApp
  readonly location?: FakeLocation
  readonly pluginOptions?: Readonly<Record<string, unknown>>
  readonly agents?: ReadonlyArray<FakeAgentInfo>
  readonly tools?: ReadonlyArray<FakeToolInfo>
  readonly plugins?: ReadonlyArray<FakePluginInfo>
  readonly scheduler?: FakeScheduler
}

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
    permission: recordDomainMethods(
      createPermissionDomain({ registry }),
      "permission",
      calls,
    ),
    session: recordDomainMethods(sessionStore.domain, "session", calls),
    event: recordDomainMethods(eventDomain, "event", calls),
    plugin: recordDomainMethods(createPluginDomain({ directory: location.directory, plugins: options?.plugins }), "plugin", calls),
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
