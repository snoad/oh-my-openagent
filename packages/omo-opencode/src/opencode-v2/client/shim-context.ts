import type {
  SessionCompactInput,
  SessionContextInput,
  SessionCreateInput,
  SessionGetInput,
  SessionInboxUser,
  SessionInterruptInput,
  SessionInterruptResponse,
  SessionListInput,
  SessionMessageInfo,
  SessionPromptInput,
  SessionInfo,
  SessionRemoveInput,
  SessionsResponse,
} from "@opencode/client"

// The OpenCode 2 ctx slices the V1 client shim consumes (task 12 of the
// opencode-v2-compat plan). Structural mirrors, not SDK type imports, for the
// agent/tool/provider entries: the pinned 2.4.1 SDK shapes are client-generated
// and unbranded, but the hermetic fake ctx (parity/fake-v2-context.ts) returns
// its own local mirrors for the editor-backed domains, so both the real ctx and
// the fake must satisfy this slice. Optional members (compact, remove) cover
// hosts whose SessionDomain omits them; the shim routes those calls to
// graceful paths instead of throwing.

export type V2ShimSessionDomain = {
  readonly create: (input?: SessionCreateInput) => Promise<SessionInfo>
  readonly get: (input: SessionGetInput) => Promise<SessionInfo>
  readonly list: (input?: SessionListInput) => Promise<SessionsResponse>
  readonly context: (input: SessionContextInput) => Promise<readonly SessionMessageInfo[]>
  readonly prompt: (input: SessionPromptInput) => Promise<SessionInboxUser>
  readonly interrupt: (input: SessionInterruptInput) => Promise<SessionInterruptResponse>
  readonly compact?: (input: SessionCompactInput) => Promise<unknown>
  readonly remove?: (input: SessionRemoveInput) => Promise<void>
}

export type V2ShimAgentInfo = {
  readonly id: string
  readonly name: string
  readonly mode: "subagent" | "primary" | "all"
  readonly description?: string
  readonly permissions?: ReadonlyArray<{
    readonly action: string
    readonly resource: string
    readonly effect: "allow" | "deny" | "ask"
  }>
}

export type V2ShimToolInfo = {
  readonly id: string
  readonly description?: string
}

export type V2ShimProviderInfo = {
  readonly id: string
  readonly name: string
}

export type V2ShimContext = {
  readonly session: V2ShimSessionDomain
  readonly agent: {
    readonly list: () => Promise<{ readonly data: ReadonlyArray<V2ShimAgentInfo> }>
  }
  readonly tool: {
    readonly list: () => Promise<ReadonlyArray<V2ShimToolInfo>>
  }
  readonly provider: {
    readonly list: () => Promise<{ readonly data: ReadonlyArray<V2ShimProviderInfo> }>
  }
}
