import type { FilePart, ToolPart } from "@opencode-ai/sdk"
import type { V1MessageWithParts, V1Part, V2AssistantContent, V2MessageOut, V2UserFileAttachment } from "./shape-codec-types"
import { assistantTime } from "./to-v1-messages"

export function fromV1Message(message: V1MessageWithParts): V2MessageOut {
  return message.info.role === "user" ? fromV1User(message) : fromV1Assistant(message)
}

function fromV1User(message: V1MessageWithParts): V2MessageOut {
  const files: V2UserFileAttachment[] = []
  const agents: { name: string }[] = []
  const texts: string[] = []
  for (const part of message.parts) {
    if (part.type === "text") texts.push(part.text)
    else if (part.type === "file") {
      files.push({ data: "", mime: part.mime, source: { type: "uri", uri: part.url }, ...(part.filename ? { name: part.filename } : {}) })
    } else if (part.type === "agent") agents.push({ name: part.name })
    else throw new Error(`fromV1Message: unknown V1 user message part type "${part.type}" (message ${message.info.id})`)
  }
  return {
    id: message.info.id,
    type: "user",
    time: { created: message.info.time.created },
    text: texts.join("\n"),
    files,
    ...(agents.length === 0 ? {} : { agents }),
  }
}

function fromV1Assistant(message: V1MessageWithParts): V2MessageOut {
  const info = message.info
  return {
    id: info.id,
    type: "assistant",
    agent: info.agent ?? "",
    model: { id: info.modelID ?? "", providerID: info.providerID ?? "" },
    content: message.parts.map((part) => assistantContent(part, info.time.created)),
    time: assistantTime(info.time),
    ...(info.finish === undefined ? {} : { finish: info.finish }),
    ...(info.cost === undefined ? {} : { cost: info.cost }),
    ...(info.tokens === undefined ? {} : { tokens: info.tokens }),
    ...(info.error === undefined ? {} : { error: info.error }),
  }
}

function assistantContent(part: V1Part, fallbackCreated: number): V2AssistantContent {
  const metadata = partMetadataOf(part)
  if (part.type === "text") {
    return { type: "text", text: part.text, ...(metadata.native === undefined ? {} : { native: asRecord(metadata.native) }) }
  }
  if (part.type === "reasoning") {
    return {
      type: "reasoning",
      text: part.text,
      ...(metadata.native === undefined ? {} : { native: asRecord(metadata.native) }),
      time: { created: part.time.start, ...(part.time.end === undefined ? {} : { completed: part.time.end }) },
    }
  }
  if (part.type === "tool") return toolContent(part, metadata, fallbackCreated)
  throw new Error(`fromV1Message: unknown V1 assistant message part type "${part.type}" (message part ${part.id})`)
}

function partMetadataOf(part: V1Part): { native?: unknown; executed?: unknown; ran?: unknown } {
  return "metadata" in part && part.metadata !== undefined && part.metadata !== null
    ? (part.metadata as { native?: unknown; executed?: unknown; ran?: unknown })
    : {}
}

function toolContent(part: ToolPart, metadata: { native?: unknown; executed?: unknown; ran?: unknown }, fallbackCreated: number): V2AssistantContent {
  const state = v2ToolState(part)
  const v1State = part.state
  const startTime = v1State.status === "pending" ? fallbackCreated : v1State.time.start
  const endTime = v1State.status === "completed" || v1State.status === "error" ? v1State.time.end : undefined
  return {
    type: "tool",
    id: part.callID,
    name: part.tool,
    ...(metadata.executed === undefined ? {} : { executed: Boolean(metadata.executed) }),
    ...(metadata.native === undefined ? {} : { native: asRecord(metadata.native) }),
    state,
    time: {
      created: startTime,
      ...(typeof metadata.ran === "number" ? { ran: metadata.ran } : {}),
      ...(endTime === undefined ? {} : { completed: endTime }),
    },
  }
}

function v2ToolState(tool: ToolPart): Extract<V2AssistantContent, { type: "tool" }>["state"] {
  const state = tool.state
  if (state.status === "pending") return { status: "streaming", input: state.raw }
  if (state.status === "running") return { status: "running", input: state.input, metadata: state.metadata ?? {} }
  if (state.status === "completed") {
    return {
      status: "completed",
      input: state.input,
      content: [{ type: "text", text: state.output }, ...fileToolContent(state.attachments)],
      metadata: state.metadata,
    }
  }
  return { status: "error", input: state.input, error: { type: "error", message: state.error }, metadata: state.metadata }
}

function fileToolContent(attachments: FilePart[] | undefined): { type: "file"; uri: string; mime: string; name?: string | null }[] {
  return (attachments ?? []).map((file) => ({
    type: "file" as const,
    uri: file.url,
    mime: file.mime,
    ...(file.filename ? { name: file.filename } : {}),
  }))
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}
