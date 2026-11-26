import type { SessionStatus } from "@opencode/client"
import type { SessionStatus as V1SessionStatus } from "@opencode-ai/sdk"

export function toV1SessionStatus(session: SessionStatus): V1SessionStatus {
  switch (session.type) {
    case "idle":
      return { type: "idle" }
    case "busy":
      return { type: "busy" }
    case "retry":
      return { type: "retry", attempt: session.attempt, message: session.message, next: session.next }
    default:
      throw new Error(`toV1SessionStatus: unknown session status type "${(session as { type: string }).type}"`)
  }
}
