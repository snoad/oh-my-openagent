import type { SessionMessageInfo } from "@opencode/client"
import type { FilePart, TextPart, ToolPart } from "@opencode-ai/sdk"
import type { V1MessageInfo, V1MessageWithParts, V1Part, V2ContextInput } from "./shape-codec-types"

type V2UserEntry = Extract<SessionMessageInfo, { type: "user" }>
type V2AssistantEntry = Extract<SessionMessageInfo, { type: "assistant" }>
type V2ToolPart = Extract<V2AssistantEntry["content"][number], { type: "tool" }>
type V2MessageTime = { created: number; completed?: number }

// Non-conversational session records (idle outcome, agent/model/location
// switches, compaction) have no V1 message equivalent and are skipped.
const SKIPPED_MESSAGE_TYPES = new Set(["idle", "agent-switched", "model-switched", "location-switched", "compaction"])

export function toV1Messages(context: V2ContextInput): V1MessageWithParts[] {
  const entries = context.messages ?? context.data
  if (entries === undefined) {
    throw new Error("toV1Messages requires context.messages or context.data (OpenCode 2 session context entries)")
  }
  return entries.flatMap((entry) => toV1MessagePair(entry, context))
}

function toV1MessagePair(entry: SessionMessageInfo, context: V2ContextInput): V1MessageWithParts[] {
  switch (entry.type) {
    case "user":
      return [userPair(entry, context)]
    case "assistant":
      return [assistantPair(entry, context)]
    default:
      if (SKIPPED_MESSAGE_TYPES.has(entry.type)) return []
      throw new Error(`toV1Messages: unknown OpenCode 2 message type "${entry.type}" (message ${entry.id})`)
  }
}

function userPair(entry: V2UserEntry, context: V2ContextInput): V1MessageWithParts {
  const text: TextPart = {
    id: `${entry.id}:0`,
    sessionID: context.sessionID,
    messageID: entry.id,
    type: "text",
    text: entry.text,
  }
  return {
    info: {
      id: entry.id,
      sessionID: context.sessionID,
      role: "user",
      time: { created: entry.time.created },
      ...(context.agent === undefined ? {} : { agent: context.agent }),
      ...(context.model === undefined ? {} : { model: { providerID: context.model.providerID, modelID: context.model.id } }),
    },
    parts: [text, ...userFileParts(entry, context), ...userAgentParts(entry, context)],
  }
}

function userFileParts(entry: V2UserEntry, context: V2ContextInput): FilePart[] {
  return (entry.files ?? []).map((file, index) => ({
    id: `${entry.id}:file:${index}`,
    sessionID: context.sessionID,
    messageID: entry.id,
    type: "file" as const,
    mime: file.mime,
    ...(file.name === undefined ? {} : { filename: file.name }),
    url: file.source.type === "uri" ? file.source.uri : "",
  }))
}

function userAgentParts(entry: V2UserEntry, context: V2ContextInput): V1Part[] {
  return (entry.agents ?? []).map((agent) => ({
    id: `${entry.id}:agent:${agent.name}`,
    sessionID: context.sessionID,
    messageID: entry.id,
    type: "agent" as const,
    name: agent.name,
  }))
}

function assistantPair(entry: V2AssistantEntry, context: V2ContextInput): V1MessageWithParts {
  const info: V1MessageInfo = {
    id: entry.id,
    sessionID: context.sessionID,
    role: "assistant",
    time: assistantTime(entry.time),
    agent: entry.agent,
    modelID: entry.model.id,
    providerID: entry.model.providerID,
    ...(entry.finish === undefined ? {} : { finish: entry.finish }),
    ...(entry.cost === undefined ? {} : { cost: entry.cost }),
    ...(entry.tokens === undefined ? {} : { tokens: entry.tokens }),
    ...(entry.error === undefined ? {} : { error: entry.error }),
  }
  return { info, parts: entry.content.map((part, index) => assistantPart(part, entry, index, context)) }
}

export function assistantTime(time: V2MessageTime): V2MessageTime {
  return time.completed === undefined ? { created: time.created } : { created: time.created, completed: time.completed }
}

function assistantPart(part: V2AssistantEntry["content"][number], entry: V2AssistantEntry, index: number, context: V2ContextInput): V1Part {
  if (part.type === "text") {
    return {
      id: textPartId(part, entry, index),
      sessionID: context.sessionID,
      messageID: entry.id,
      type: "text",
      text: part.text,
      ...(part.native === undefined ? {} : { metadata: { native: part.native } }),
    }
  }
  if (part.type === "reasoning") {
    return {
      id: textPartId(part, entry, index),
      sessionID: context.sessionID,
      messageID: entry.id,
      type: "reasoning",
      text: part.text,
      ...(part.native === undefined ? {} : { metadata: { native: part.native } }),
      time: { start: part.time?.created ?? entry.time.created },
    }
  }
  if (part.type === "tool") return toolPart(part, entry, context)
  throw new Error(`toV1Messages: unknown OpenCode 2 assistant content part type "${(part as { type: string }).type}" (message ${entry.id})`)
}

function textPartId(part: { native?: { [x: string]: unknown } | null }, entry: V2AssistantEntry, index: number): string {
  const itemId = part.native?.itemId
  return typeof itemId === "string" ? itemId : `${entry.id}:text:${index}`
}

function toolPart(part: V2ToolPart, entry: V2AssistantEntry, context: V2ContextInput): ToolPart {
  const metadata = toolPartMetadata(part)
  return {
    id: part.id,
    sessionID: context.sessionID,
    messageID: entry.id,
    type: "tool",
    callID: part.id,
    tool: part.name,
    state: toolState(part),
    ...(metadata === undefined ? {} : { metadata }),
  }
}

function toolPartMetadata(part: V2ToolPart): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {}
  if (part.native !== undefined) metadata.native = part.native
  if (part.executed !== undefined) metadata.executed = part.executed
  if (part.time.ran !== undefined) metadata.ran = part.time.ran
  return Object.keys(metadata).length === 0 ? undefined : metadata
}

function toolState(part: V2ToolPart): ToolPart["state"] {
  const state = part.state
  const start = part.time.created
  const end = part.time.completed ?? part.time.ran ?? part.time.created
  if (state.status === "streaming") return { status: "pending", input: {}, raw: state.input }
  if (state.status === "running") return { status: "running", input: state.input, metadata: state.metadata, time: { start } }
  if (state.status === "completed") {
    return {
      status: "completed",
      input: state.input,
      output: joinedTextOutput(state.content),
      title: part.name,
      metadata: state.metadata ?? {},
      time: { start, end },
    }
  }
  return { status: "error", input: state.input, error: state.error.message, metadata: state.metadata, time: { start, end } }
}

function joinedTextOutput(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n")
}
