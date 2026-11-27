import { fromV1Message } from "../client/from-v1-message"
import type { V2MessageOut } from "../client/shape-codec-types"
import type { V1MessageWithParts } from "../client/shape-codec-types"

import type { V2HookContextEvent, V2HookMessage } from "./context-message-codec"

// Id-keyed write-back of the V1 messages-transform output onto the OpenCode 2
// context payload (plan task 17). The upstream bug class this module exists
// for: an index-based write-back moved an assistant's reasoning and tool-call
// parts into the tool message and every provider rejected the request
// (issues #9389, PR #9391). Keying follows the recorded host payload
// (hook-context-b.json): message id for user/assistant messages, toolCallId
// for the idless tool message, never an array position.

type AssistantOut = Extract<V2MessageOut, { type: "assistant" }>
type AssistantOutTool = Extract<AssistantOut["content"][number], { type: "tool" }>
type UserOut = Extract<V2MessageOut, { type: "user" }>

export function writeBackMessages(event: V2HookContextEvent, v1Messages: V1MessageWithParts[]): void {
  const outMessages = v1Messages.map((message) => fromV1Message(message))
  const outById = new Map<string, V2MessageOut>()
  const toolCallOwner = new Map<string, string>()
  for (const message of outMessages) {
    outById.set(message.id, message)
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type === "tool") toolCallOwner.set(part.id, message.id)
    }
  }
  const consumedIds = new Set<string>()
  // Reverse walk so filtered messages splice out without shifting the keys of
  // the messages still to visit; keys, not positions, drive every decision.
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index]
    if (message === undefined) continue
    if (!rewriteMessage(message, outById, toolCallOwner, consumedIds)) event.messages.splice(index, 1)
  }
  for (const message of outMessages) {
    if (!consumedIds.has(message.id)) event.messages.push(appendedHookMessage(message))
  }
}

function rewriteMessage(
  message: V2HookMessage,
  outById: Map<string, V2MessageOut>,
  toolCallOwner: Map<string, string>,
  consumedIds: Set<string>,
): boolean {
  const id = message.id
  if (typeof id === "string") {
    const out = outById.get(id)
    if (out === undefined) return false
    consumedIds.add(id)
    message.content = out.type === "assistant" ? assistantHookContent(out) : userHookContent(out)
    return true
  }
  return rewriteToolMessage(message, outById, toolCallOwner, consumedIds)
}

// A tool message survives only while every tool-result it carries still has
// an owning assistant tool part in the V1 output; a filtered owner removes
// the orphaned message with it.
function rewriteToolMessage(
  message: V2HookMessage,
  outById: Map<string, V2MessageOut>,
  toolCallOwner: Map<string, string>,
  consumedIds: Set<string>,
): boolean {
  const rebuilt: Array<Record<string, unknown>> = []
  for (const part of message.content) {
    const callId = part["type"] === "tool-result" && typeof part["id"] === "string" ? part["id"] : undefined
    if (callId === undefined) {
      rebuilt.push(part)
      continue
    }
    const ownerId = toolCallOwner.get(callId)
    const owner = ownerId === undefined ? undefined : outById.get(ownerId)
    if (owner === undefined || owner.type !== "assistant") return false
    consumedIds.add(owner.id)
    const toolPart = owner.content.find(
      (candidate): candidate is AssistantOutTool => candidate.type === "tool" && candidate.id === callId,
    )
    const next = toolPart === undefined ? undefined : toolResultHookPart(part, toolPart)
    rebuilt.push(next ?? part)
  }
  message.content = rebuilt
  return true
}

// Only a finished result rewrites the tool message; a still-streaming V1 tool
// state keeps the recorded tool-result part unchanged.
function toolResultHookPart(
  original: Record<string, unknown>,
  toolPart: AssistantOutTool,
): Record<string, unknown> | undefined {
  const state = toolPart.state
  if (state.status === "completed") {
    return { ...original, result: { type: "text", value: firstTextOf(state.content) } }
  }
  if (state.status === "error") return { ...original, result: { type: "error", value: state.error.message } }
  return undefined
}

function firstTextOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")
}

function userHookContent(out: UserOut): Array<Record<string, unknown>> {
  return [{ type: "text", text: out.text }]
}

function assistantHookContent(out: AssistantOut): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = []
  for (const part of out.content) {
    const native = part.native
    const metadata = native === undefined ? {} : { providerMetadata: native }
    if (part.type === "text") content.push({ type: "text", text: part.text, ...metadata })
    else if (part.type === "reasoning") content.push({ type: "reasoning", text: part.text, ...metadata })
    else if (part.type === "tool") {
      content.push({
        type: "tool-call",
        id: part.id,
        name: part.name,
        input: toolCallInputOf(part),
        providerExecuted: part.executed === true,
        ...metadata,
      })
    }
  }
  return content
}

function toolCallInputOf(part: AssistantOutTool): unknown {
  const input = part.state.input
  if (typeof input !== "string") return input
  try {
    return JSON.parse(input) as unknown
  } catch {
    return input
  }
}

function appendedHookMessage(message: V2MessageOut): V2HookMessage {
  return message.type === "assistant"
    ? { id: message.id, role: "assistant", content: assistantHookContent(message) }
    : { id: message.id, role: "user", content: userHookContent(message) }
}
