// Shape types of the fake OpenCode 2 plugin context (tasks 9 and 12-35 of the opencode-v2-compat plan),
// split out of fake-v2-context.ts and re-exported from there. Domains mirror the pinned
// node_modules/@opencode/plugin 2.4.1 surface; app and the session methods are typed through the sanctioned
// root type import (they are plain in the 2.4.1 client types), the editor and hook payload surfaces are
// local structural mirrors (the SDK ones carry effect-branded schema types).

import type { Plugin } from "@opencode/plugin"

import type {
  FakeAgentDomain,
  FakeAgentEditor,
  FakeAgentInfo,
  FakeToolDomain,
  FakeToolEditor,
  FakeToolInfo,
} from "./fake-v2-editors"
import type {
  FakeCommandDefinition,
  FakeCommandDomain,
  FakeCommandEditor,
  FakeMcpDomain,
  FakeMcpEditor,
  FakeSkillDomain,
  FakeSkillEditor,
} from "./fake-v2-mcp-command-skill-domains"
import type {
  FakeModelDomain,
  FakeModelEditor,
  FakeProviderDomain,
  FakeProviderEditor,
} from "./fake-v2-provider-model-domains"
import type { FakeHookOptions, FakeScheduler, FakeSubscribeOptions, FakeV2Event } from "./fake-v2-registry"
import type { FakeSessionDomain, FakeSessionRecord } from "./fake-v2-session-store"
import type { FakePermissionDomain, FakePluginDomain, FakePluginInfo, FakeShellDomain } from "./fake-v2-support-domains"
import type { FakeJsonValue, FakeRpcDomain, FakeStorageDomain } from "./fake-v2-rpc-storage-domains"

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
  readonly __fire: <TEvent>(
    domain: FakeHookDomainName,
    name: string,
    event: TEvent,
    options?: FakeHookOptions,
  ) => Promise<TEvent>
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
