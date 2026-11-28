// Structural mirrors of the pinned 2.4.1 AgentEditor surface (task 24). The
// SDK editor exposes effect-branded Agent.Info items (DeepMutable<Agent.Info>
// over @opencode/schema) that cannot be constructed outside the host, so the
// replay types stay plain: the real host ctx, the fake ctx editor
// (parity/fake-v2-editors.ts) and the row harnesses all satisfy them
// structurally. defaultAgent() is the fake-only getter; the real 2.4.1 editor
// carries default(id) as a setter with no reader.

export type AgentReplayPermissionRule = {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

export type AgentReplayItem = {
  readonly id: string
  name: string
  mode: "primary" | "subagent" | "all"
  hidden: boolean
  system?: string
  description?: string
  model?: { readonly id: string; readonly providerID: string }
  permissions?: ReadonlyArray<AgentReplayPermissionRule>
}

export type AgentReplayEditor = {
  readonly list: () => ReadonlyArray<AgentReplayItem>
  readonly get: (id: string) => AgentReplayItem | undefined
  readonly default: (id: string | undefined) => void
  readonly defaultAgent?: () => string | undefined
  readonly update: (id: string, update: (item: AgentReplayItem) => void) => void
  readonly remove: (id: string) => void
}

export type AgentReplayContext = {
  readonly agent: {
    readonly transform: (callback: (editor: AgentReplayEditor) => void) => Promise<unknown>
  }
}
