import type { Part, SessionStatus } from "@opencode-ai/sdk"
import type { V1MessageInfo, V1Part } from "../client/shape-codec-types"

// V1 event shapes emitted by the OpenCode 2 translation layer (plan task 14).
// The union mirrors @opencode-ai/sdk Event members where they can be populated
// honestly (session.idle, session.status, message.part.updated) and uses the
// task-11 tolerant mirrors where the strict SDK shapes cannot be populated
// from OpenCode 2 payloads (session info, message info, session.error).

export type V1SessionInfoOut = {
  readonly id: string
  readonly sessionID?: string
  readonly title?: string
  readonly parentID?: string
  readonly slug?: string
  readonly projectID?: string
  readonly directory?: string
  readonly version?: string
  readonly agent?: string
  readonly model?: { readonly id: string; readonly providerID: string }
  readonly metadata?: Record<string, unknown>
  readonly time: { readonly created: number; readonly updated?: number }
}

export type V1StatusOut = SessionStatus

// The mutable twin of V1SessionInfoOut: the snapshot store's session info
// registry holds these so a later session.renamed can merge the title into
// the object the already emitted session.created event references.
export type WritableV1SessionInfo = { -readonly [K in keyof V1SessionInfoOut]: V1SessionInfoOut[K] }

export type V1OutEvent =
  | {
      readonly type: "session.created"
      readonly properties: { readonly sessionID: string; readonly info: V1SessionInfoOut }
    }
  | {
      readonly type: "session.deleted"
      readonly properties: { readonly sessionID: string; readonly info: { readonly id: string } }
    }
  | { readonly type: "session.idle"; readonly properties: { readonly sessionID: string } }
  | {
      readonly type: "session.status"
      readonly properties: { readonly sessionID: string; readonly status: V1StatusOut }
    }
  | { readonly type: "session.error"; readonly properties: { readonly sessionID: string; readonly error?: unknown } }
  | { readonly type: "session.compaction.ended"; readonly properties: { readonly sessionID: string } }
  | { readonly type: "session.compaction.failed"; readonly properties: { readonly sessionID: string } }
  | {
      readonly type: "message.updated"
      readonly properties: { readonly sessionID: string; readonly info: V1MessageInfo }
    }
  | {
      readonly type: "message.part.updated"
      readonly properties: { readonly sessionID: string; readonly part: Part; readonly time: number }
    }
  | {
      readonly type: "message.removed"
      readonly properties: { readonly sessionID: string; readonly messageID: string }
    }

export function v1EventSessionID(event: V1OutEvent): string | undefined {
  const properties = event.properties as Record<string, unknown>
  const info = properties.info as Record<string, unknown> | undefined
  const part = properties.part as Record<string, unknown> | undefined
  for (const candidate of [properties.sessionID, info?.sessionID, info?.id, part?.sessionID]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate
  }
  return undefined
}
