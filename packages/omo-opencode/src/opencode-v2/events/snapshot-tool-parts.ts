import type { JsonValue, SessionMessageInfo } from "@opencode/client"

import { isRecord } from "./v2-event-payload"

// Tool part merges (plan task 14): the OpenCode 2 tool lifecycle
// (input.started -> input.ended -> called -> progress -> success/failed)
// mapped onto the V2 tool part shape the task-11 codec consumes. Copy-on-
// write over the assistant entry's content; a merge whose tool part does not
// exist returns undefined, which tells translate to schedule a refresh.

type AssistantEntry = Extract<SessionMessageInfo, { type: "assistant" }>
type ToolPart = Extract<AssistantEntry["content"][number], { type: "tool" }>
type ToolState = ToolPart["state"]
type CompletedState = Extract<ToolState, { status: "completed" }>
type ErrorState = Extract<ToolState, { status: "error" }>

function toolIndexOf(entry: AssistantEntry, callID: string): number {
  return entry.content.findIndex((part) => part.type === "tool" && part.id === callID)
}

function patchToolPart(
  entry: AssistantEntry,
  callID: string,
  patch: (part: ToolPart) => ToolPart,
): AssistantEntry | undefined {
  const index = toolIndexOf(entry, callID)
  if (index === -1) return undefined
  const part = entry.content[index]
  if (part.type !== "tool") return undefined
  const content = [...entry.content]
  content[index] = patch(part)
  return { ...entry, content }
}

export function toolInputStartedPatch(
  entry: AssistantEntry,
  callID: string,
  name: string,
  created: number,
): AssistantEntry {
  const part: ToolPart = {
    type: "tool",
    id: callID,
    name,
    state: { status: "streaming", input: "" },
    time: { created },
  }
  const content = [...entry.content]
  const index = toolIndexOf(entry, callID)
  if (index === -1) content.push(part)
  else content[index] = part
  return { ...entry, content }
}

export function toolInputEndedPatch(entry: AssistantEntry, callID: string, text: string): AssistantEntry | undefined {
  return patchToolPart(entry, callID, (part) => ({
    ...part,
    state: part.state.status === "streaming" ? { ...part.state, input: text } : part.state,
  }))
}

export function toolCalledPatch(
  entry: AssistantEntry,
  callID: string,
  input: Record<string, JsonValue>,
  native: unknown,
  executed: boolean | undefined,
  created: number,
): AssistantEntry | undefined {
  return patchToolPart(entry, callID, (part) => ({
    ...part,
    state: { status: "running", input, metadata: carriedMetadata(part.state) },
    ...(isRecord(native) ? { native } : {}),
    ...(executed === undefined ? {} : { executed }),
    time: { ...part.time, ran: created },
  }))
}

export function toolProgressPatch(
  entry: AssistantEntry,
  callID: string,
  metadata: Record<string, JsonValue>,
): AssistantEntry | undefined {
  return patchToolPart(entry, callID, (part) => {
    if (part.state.status === "streaming") return part
    return { ...part, state: { ...part.state, metadata } }
  })
}

export function toolSuccessPatch(
  entry: AssistantEntry,
  callID: string,
  content: ReadonlyArray<unknown>,
  executed: boolean | undefined,
  metadata: Record<string, JsonValue> | undefined,
  created: number,
): AssistantEntry | undefined {
  return patchToolPart(entry, callID, (part) => ({
    ...part,
    state: {
      status: "completed",
      input: carriedInput(part.state),
      content: content as CompletedState["content"],
      ...(metadata === undefined ? {} : { metadata }),
    },
    ...(executed === undefined ? {} : { executed }),
    time: { ...part.time, completed: created },
  }))
}

export function toolFailedPatch(
  entry: AssistantEntry,
  callID: string,
  error: Record<string, JsonValue>,
  metadata: Record<string, JsonValue> | undefined,
  created: number,
): AssistantEntry | undefined {
  return patchToolPart(entry, callID, (part) => ({
    ...part,
    state: {
      status: "error",
      input: carriedInput(part.state),
      error: error as ErrorState["error"],
      ...(metadata === undefined ? {} : { metadata }),
    },
    time: { ...part.time, completed: created },
  }))
}

function carriedInput(state: ToolState): CompletedState["input"] {
  return state.status === "running" || state.status === "completed" || state.status === "error"
    ? (state.input as CompletedState["input"])
    : {}
}

// The SDK's running state requires metadata; tool.called arrives while the
// previous state is streaming (which carries none), so the merge carries any
// metadata an earlier non-streaming state recorded and defaults to {}.
function carriedMetadata(state: ToolState): Record<string, JsonValue> {
  if (state.status === "streaming") return {}
  return state.metadata ?? {}
}
