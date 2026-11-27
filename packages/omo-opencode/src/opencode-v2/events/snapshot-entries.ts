import type { SessionMessageInfo } from "@opencode/client"

import { isRecord } from "./v2-event-payload"

// Copy-on-write merges of OpenCode 2 event payloads into the V2 session
// entry list the snapshot store diffs (plan task 14). Identity-first: every
// merge takes the message and part identities straight from the event
// payload; a merge that cannot build or update the entry returns undefined,
// which tells translate to schedule a context() refresh instead.

type UserEntry = Extract<SessionMessageInfo, { type: "user" }>
type AssistantEntry = Extract<SessionMessageInfo, { type: "assistant" }>
type AssistantContent = AssistantEntry["content"]
type TextPart = Extract<AssistantContent[number], { type: "text" }>
type ReasoningPart = Extract<AssistantContent[number], { type: "reasoning" }>

function isAssistantEntry(entry: SessionMessageInfo): entry is AssistantEntry {
  return entry.type === "assistant"
}

function replaceEntry(
  entries: readonly SessionMessageInfo[],
  index: number,
  updated: SessionMessageInfo,
): readonly SessionMessageInfo[] {
  return [...entries.slice(0, index), updated, ...entries.slice(index + 1)]
}

export function mergeEntryList(
  entries: readonly SessionMessageInfo[],
  entry: SessionMessageInfo,
): readonly SessionMessageInfo[] {
  const index = entries.findIndex((existing) => existing.id === entry.id)
  return index === -1 ? [...entries, entry] : replaceEntry(entries, index, entry)
}

export function patchAssistantEntry(
  entries: readonly SessionMessageInfo[],
  messageID: string,
  patch: (entry: AssistantEntry) => AssistantEntry | undefined,
  create?: () => AssistantEntry,
): readonly SessionMessageInfo[] | undefined {
  const index = entries.findIndex((existing) => existing.id === messageID && isAssistantEntry(existing))
  if (index === -1) {
    if (create === undefined) return undefined
    const created = patch(create())
    return created === undefined ? undefined : [...entries, created]
  }
  const existing = entries[index]
  if (!isAssistantEntry(existing)) return undefined
  const patched = patch(existing)
  return patched === undefined ? undefined : replaceEntry(entries, index, patched)
}

export function inboxUserEntry(inboxID: string, item: Record<string, unknown>, created: number): UserEntry | undefined {
  if (item.type !== "user" || !isRecord(item.payload)) return undefined
  const payload = item.payload
  if (typeof payload.text !== "string") return undefined
  return {
    id: inboxID,
    type: "user",
    time: { created },
    text: payload.text,
    files: Array.isArray(payload.files) ? (payload.files as UserEntry["files"]) : [],
    ...(Array.isArray(payload.agents) ? { agents: payload.agents as UserEntry["agents"] } : {}),
  }
}

export function stepStartedEntry(
  messageID: string,
  agent: string,
  model: { id: string; providerID: string },
  started: number,
): AssistantEntry {
  return { id: messageID, type: "assistant", agent, model, content: [], time: { created: started } }
}

export function stepEndedPatch(
  entry: AssistantEntry,
  finish: string | undefined,
  cost: number | undefined,
  tokens: unknown,
  completed: number,
): AssistantEntry {
  return {
    ...entry,
    ...(finish === undefined ? {} : { finish: finish as AssistantEntry["finish"] }),
    ...(cost === undefined ? {} : { cost }),
    ...(isRecord(tokens) ? { tokens: tokens as AssistantEntry["tokens"] } : {}),
    time: { ...entry.time, completed },
  }
}

export function textEndedPatch(entry: AssistantEntry, ordinal: number, text: string, native: unknown): AssistantEntry {
  return patchContentPart(entry, ordinal, { type: "text", text, ...(isRecord(native) ? { native } : {}) })
}

export function reasoningEndedPatch(
  entry: AssistantEntry,
  ordinal: number,
  text: string,
  native: unknown,
  time: unknown,
): AssistantEntry {
  const part: ReasoningPart = {
    type: "reasoning",
    text,
    ...(isRecord(native) ? { native } : {}),
    ...(isReasoningTime(time) ? { time } : {}),
  }
  return patchContentPart(entry, ordinal, part)
}

function isReasoningTime(value: unknown): value is ReasoningPart["time"] {
  return isRecord(value) && typeof value.created === "number"
}

function patchContentPart(entry: AssistantEntry, ordinal: number, part: TextPart | ReasoningPart): AssistantEntry {
  const content = [...entry.content]
  if (ordinal >= 0 && ordinal <= content.length) content[ordinal] = part
  else content.push(part)
  return { ...entry, content }
}

// The content array is passed through to the codec, which throws on part
// types it cannot map; that throw is the translation-failure isolation path.
export function contentUpdatedPatch(entry: AssistantEntry, content: ReadonlyArray<unknown>): AssistantEntry {
  return { ...entry, content: content as AssistantContent }
}
