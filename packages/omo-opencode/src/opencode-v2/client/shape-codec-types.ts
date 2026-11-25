import type {
  AgentPart,
  FilePart,
  ReasoningPart,
  TextPart,
  ToolPart,
} from "@opencode-ai/sdk"
import type { SessionMessageInfo, SessionPromptInput } from "@opencode/client"

// Shapes produced and consumed by the V1 <-> OpenCode 2 session shape codecs.
// The V1 side mirrors @opencode-ai/sdk (1.x) structurally: the engine readers
// (prompt-async-gate session-idle-dispatch, parent-wake-session-inspector) read
// info fields tolerantly, so the codec types carry exactly the fields the two
// API generations can populate. V2-only extras (snapshot, streaming timestamps)
// have no V1 home and are dropped at this boundary.

export type V2ModelRef = { readonly id: string; readonly providerID: string }

// `messages` is the session.context hook payload array; `data` is the
// ctx.session.context() response envelope. One of the two is required.
export type V2ContextInput = {
  readonly data?: readonly SessionMessageInfo[]
  readonly messages?: readonly SessionMessageInfo[]
  readonly sessionID: string
  readonly agent?: string
  readonly model?: V2ModelRef
}

export type V1TokenUsage = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type V1MessageInfo = {
  id: string
  sessionID?: string
  role: "user" | "assistant"
  time: { created: number; completed?: number }
  agent?: string
  model?: { providerID: string; modelID: string }
  modelID?: string
  providerID?: string
  finish?: string
  cost?: number
  tokens?: V1TokenUsage
  error?: unknown
}

export type V1Part = TextPart | ReasoningPart | FilePart | ToolPart | AgentPart
export type V1TextPartInput = TextPart
export type V1FilePartInput = FilePart

export type V1MessageWithParts = {
  info: V1MessageInfo
  parts: V1Part[]
}

export type V2AgentAttachment = { name: string }

export type V2UserFileAttachment = {
  data: string
  mime: string
  source: { type: "inline" } | { type: "uri"; uri: string }
  name?: string
}

export type V2StructuredError = { type: string; message: string }

export type V2ToolStateOut =
  | { status: "streaming"; input: string }
  | { status: "running"; input: Record<string, unknown>; metadata: Record<string, unknown> }
  | {
      status: "completed"
      input: Record<string, unknown>
      content: V2ToolContentOut[]
      metadata?: Record<string, unknown>
    }
  | {
      status: "error"
      input: Record<string, unknown>
      error: V2StructuredError
      content?: V2ToolContentOut[]
      metadata?: Record<string, unknown>
    }

export type V2ToolContentOut =
  | { type: "text"; text: string }
  | { type: "file"; uri: string; mime: string; name?: string | null }

export type V2AssistantContent =
  | { type: "text"; text: string; native?: Record<string, unknown> }
  | {
      type: "reasoning"
      text: string
      native?: Record<string, unknown>
      time?: { created: number; completed?: number }
    }
  | {
      type: "tool"
      id: string
      name: string
      executed?: boolean
      native?: Record<string, unknown>
      state: V2ToolStateOut
      time: { created: number; ran?: number; completed?: number }
    }

export type V2UserMessageOut = {
  id: string
  type: "user"
  time: { created: number }
  text: string
  files: V2UserFileAttachment[]
  agents?: V2AgentAttachment[]
}

export type V2AssistantMessageOut = {
  id: string
  type: "assistant"
  agent: string
  model: V2ModelRef
  content: V2AssistantContent[]
  time: { created: number; completed?: number }
  finish?: string
  cost?: number
  tokens?: V1TokenUsage
  error?: unknown
}

export type V2MessageOut = V2UserMessageOut | V2AssistantMessageOut

export type V2ToolResultInput = {
  title?: string
  content?: readonly V2ToolContentOut[]
  metadata?: Record<string, unknown>
}

export type V1ToolResult = {
  title?: string
  output: string
  metadata?: Record<string, unknown>
}

export type V2PromptInputArgs = {
  readonly sessionID: string
  readonly parts?: readonly V1Part[]
  readonly text?: string
  readonly agent?: string
  readonly metadata?: SessionPromptInput["metadata"]
}
