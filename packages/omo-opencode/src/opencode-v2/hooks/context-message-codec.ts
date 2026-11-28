import type { SessionMessageInfo, SessionMessageNative } from "@opencode/client"

// Local structural mirror of the OpenCode 2 `context` hook payload (2.4.1
// node_modules/@opencode/plugin/dist/promise/session.d.ts SessionContext).
// The SDK hook types carry effect brands, so the V2 adapters consume
// plain-string mirrors (task-9 sanctioned branch); `messages` is the
// LLM-facing shape recorded in parity/fixtures/host-2.4.1/hook-context-b.json:
// user and assistant messages carry ids, the tool message has no id and is
// correlated through its tool-result part id (the toolCallId).

export type V2HookSystemPart = { type: string; text?: string }

export type V2HookMessage = {
  id?: string
  role?: string
  content: Array<Record<string, unknown>>
}

export type V2HookContextEvent = {
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly id: string; readonly providerID: string }
  system: V2HookSystemPart[]
  messages: V2HookMessage[]
  options: Record<string, unknown>
  // The 2.4.1 SessionContext tools map (name -> {description, input}); the
  // task-27 request filter deletes hidden entries in place.
  tools: Record<string, { description: string; input: unknown }>
}

const TOOL_RESULT_PART = "tool-result"

function isTextSystemPart(part: V2HookSystemPart): boolean {
  return part.type === "text" && typeof part.text === "string"
}

export function systemTextsOf(system: ReadonlyArray<V2HookSystemPart>): string[] {
  return system.filter(isTextSystemPart).map((part) => part.text ?? "")
}

// Write-back per plan task 17: replace the text parts in order, append extra
// entries as text parts and leave every non-text part untouched.
export function writeBackSystem(system: V2HookSystemPart[], texts: string[]): void {
  let textIndex = 0
  for (const part of system) {
    if (!isTextSystemPart(part) || textIndex >= texts.length) continue
    part.text = texts[textIndex]
    textIndex += 1
  }
  for (; textIndex < texts.length; textIndex += 1) {
    const text = texts[textIndex]
    if (text !== undefined) system.push({ type: "text", text })
  }
}

type AssistantEntry = Extract<SessionMessageInfo, { type: "assistant" }>
type AssistantToolContent = Extract<AssistantEntry["content"][number], { type: "tool" }>

// Converts the hook payload into the storage shape the task-11 codecs accept.
// Tool-result messages are not standalone V1 messages (V1 only knows user and
// assistant), so each result merges into the assistant tool part that owns its
// toolCallId, regardless of array position (the order-shuffle regression).
export function storageEntriesOf(event: V2HookContextEvent): SessionMessageInfo[] {
  const entries: SessionMessageInfo[] = []
  const toolResults = new Map<string, Record<string, unknown>>()
  for (const message of event.messages) {
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part["type"] === TOOL_RESULT_PART && typeof part["id"] === "string") {
          toolResults.set(part["id"], part)
        }
      }
      continue
    }
    if (typeof message.id !== "string") continue
    if (message.role === "user") entries.push(storageUserEntry(message))
    else if (message.role === "assistant") entries.push(storageAssistantEntry(message, event))
  }
  for (const entry of entries) {
    if (entry.type === "assistant") mergeToolResults(entry, toolResults)
  }
  return entries
}

function mergeToolResults(entry: AssistantEntry, toolResults: Map<string, Record<string, unknown>>): void {
  for (const part of entry.content) {
    if (part.type !== "tool" || !toolResults.has(part.id)) continue
    const result = toolResults.get(part.id)
    if (result === undefined) continue
    part.state = completedToolState(part, result)
    part.time = { created: part.time.created, completed: part.time.created }
  }
}

function storageUserEntry(message: V2HookMessage): SessionMessageInfo {
  const texts = message.content.filter((part) => part["type"] === "text").map((part) => String(part["text"] ?? ""))
  return { id: message.id ?? "", type: "user", time: { created: 0 }, text: texts.join("\n"), files: [] }
}

function storageAssistantEntry(message: V2HookMessage, event: V2HookContextEvent): AssistantEntry {
  const content: AssistantEntry["content"] = []
  for (const part of message.content) {
    if (part["type"] === "text") content.push(textContent(part))
    else if (part["type"] === "reasoning") content.push(reasoningContent(part))
    else if (part["type"] === "tool-call") content.push(pendingToolContent(part))
  }
  return {
    id: message.id ?? "",
    type: "assistant",
    agent: event.agent,
    model: { id: event.model.id, providerID: event.model.providerID },
    time: { created: 0 },
    content,
  }
}

function nativeOf(part: Record<string, unknown>): SessionMessageNative | undefined {
  const native = part["providerMetadata"]
  return typeof native === "object" && native !== null ? (native as SessionMessageNative) : undefined
}

function textContent(part: Record<string, unknown>): AssistantEntry["content"][number] {
  const native = nativeOf(part)
  return { type: "text", text: String(part["text"] ?? ""), ...(native === undefined ? {} : { native }) }
}

function reasoningContent(part: Record<string, unknown>): AssistantEntry["content"][number] {
  const native = nativeOf(part)
  return {
    type: "reasoning",
    text: String(part["text"] ?? ""),
    time: { created: 0 },
    ...(native === undefined ? {} : { native }),
  }
}

function pendingToolContent(part: Record<string, unknown>): AssistantEntry["content"][number] {
  const native = nativeOf(part)
  const input = part["input"]
  return {
    type: "tool",
    id: String(part["id"] ?? ""),
    name: String(part["name"] ?? ""),
    executed: part["providerExecuted"] === true,
    state: { status: "streaming", input: typeof input === "string" ? input : JSON.stringify(input ?? {}) },
    time: { created: 0 },
    ...(native === undefined ? {} : { native }),
  }
}

function completedToolState(
  tool: AssistantToolContent,
  result: Record<string, unknown>,
): AssistantToolContent["state"] {
  const value = result["result"]
  return {
    status: "completed",
    input: readToolInput(tool.state),
    content: [{ type: "text", text: resultValueText(value) }],
    metadata: {},
  }
}

function readToolInput(state: AssistantToolContent["state"]): SessionMessageNative {
  const input = "input" in state ? state.input : undefined
  return typeof input === "object" && input !== null ? (input as SessionMessageNative) : {}
}

function resultValueText(value: unknown): string {
  if (typeof value === "object" && value !== null && "type" in value) {
    const record = value as Record<string, unknown>
    if (record["type"] === "content" && Array.isArray(record["value"])) {
      return record["value"].map((item) => String((item as Record<string, unknown>)["text"] ?? "")).join("\n")
    }
    return String(record["value"] ?? "")
  }
  return String(value ?? "")
}
