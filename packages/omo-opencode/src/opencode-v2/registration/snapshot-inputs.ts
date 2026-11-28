// Input mirrors of the OpenCode 2 host state the registration snapshot reads
// (task 22 of the opencode-v2-compat plan). Structural mirrors of the pinned
// node_modules/@opencode/plugin 2.4.1 domain surfaces, kept plain so the real
// ctx, the fake ctx (parity/fake-v2-context.ts) and the client shim context
// all satisfy them. The record values are what a domain transform (tasks 24 to
// 28) hands back from editor.list() at replay time BEFORE its own edits.

export type SnapshotPermissionRule = {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

export type SnapshotAgentRecord = {
  readonly id: string
  readonly name: string
  readonly mode: "subagent" | "primary" | "all"
  readonly hidden?: boolean
  readonly description?: string
  readonly system?: string
  readonly model?: { readonly id: string; readonly providerID: string }
  readonly permissions?: ReadonlyArray<SnapshotPermissionRule>
}

export type SnapshotToolRecord = {
  readonly id: string
  readonly description?: string
}

export type SnapshotMcpListEntry = {
  readonly name: string
  readonly status: unknown
}

export type SnapshotCommandRecord = {
  readonly name: string
  readonly description?: string
}

export type SnapshotProviderRecord = {
  readonly id: string
  readonly name: string
}

export type SnapshotModelRecord = {
  readonly id: string
  readonly modelID: string
  readonly providerID: string
  readonly name: string
}

export type SnapshotModelDefault = {
  readonly providerID: string
  readonly modelID: string
}

export type SnapshotContext = {
  readonly agent: {
    readonly list: () => Promise<{ readonly data: ReadonlyArray<SnapshotAgentRecord> }>
  }
  readonly tool: {
    readonly list: () => Promise<ReadonlyArray<SnapshotToolRecord>>
  }
  readonly mcp: {
    readonly list: () => Promise<{ readonly data: ReadonlyArray<SnapshotMcpListEntry> }>
  }
  readonly command: {
    readonly list: () => Promise<{ readonly data: ReadonlyArray<SnapshotCommandRecord> }>
  }
  readonly provider: {
    readonly list: () => Promise<{ readonly data: ReadonlyArray<SnapshotProviderRecord> }>
  }
  readonly model: {
    readonly list: () => Promise<{ readonly data: ReadonlyArray<SnapshotModelRecord> }>
    readonly default?: () => Promise<{ readonly data: SnapshotModelRecord | null }>
  }
}

export type SnapshotDomain = "agent" | "permission" | "tool" | "mcp" | "command" | "provider" | "model"

export type AgentSnapshotValue = {
  readonly agents: ReadonlyArray<SnapshotAgentRecord>
  readonly defaultAgent?: string
}

export type ProviderSnapshotValue = ReadonlyArray<{
  readonly provider: SnapshotProviderRecord
  readonly models: ReadonlyArray<SnapshotModelRecord>
}>

export type ModelSnapshotValue = {
  readonly models: ReadonlyArray<SnapshotModelRecord>
  readonly defaultModel?: SnapshotModelDefault
}

export type SnapshotRecordValue =
  | { readonly domain: "agent"; readonly value: AgentSnapshotValue }
  | { readonly domain: "permission"; readonly value: ReadonlyArray<SnapshotPermissionRule> }
  | { readonly domain: "tool"; readonly value: ReadonlyArray<SnapshotToolRecord> }
  | { readonly domain: "mcp"; readonly value: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> }
  | { readonly domain: "command"; readonly value: ReadonlyArray<SnapshotCommandRecord> }
  | { readonly domain: "provider"; readonly value: ProviderSnapshotValue }
  | { readonly domain: "model"; readonly value: ModelSnapshotValue }
