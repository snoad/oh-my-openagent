import type { SessionMessageInfo } from "@opencode/client"

import type { SnapshotStore } from "./snapshot-store"
import {
  contentUpdatedPatch,
  inboxUserEntry,
  mergeEntryList,
  patchAssistantEntry,
  reasoningEndedPatch,
  stepEndedPatch,
  stepStartedEntry,
  textEndedPatch,
} from "./snapshot-entries"
import { translateToolSnapshotPatch } from "./snapshot-tool-patches"
import type { V1OutEvent } from "./v1-out-event"
import { isRecord, numberField, stringField, type V2EventPayload } from "./v2-event-payload"

// Routing of the snapshot-diff V2 sources (plan task 14): each event patches
// the session entries from its own payload when the payload carries the
// identity a V1 consumer reads, and schedules a coalesced context() refresh
// through the store when it does not. The session.tool.* cases live in
// snapshot-tool-patches.ts.

function refresh(store: SnapshotStore, sessionID: string): V1OutEvent[] {
  store.scheduleRefresh(sessionID)
  return []
}

function applyPatch(
  store: SnapshotStore,
  sessionID: string,
  updated: readonly SessionMessageInfo[] | undefined,
): V1OutEvent[] {
  return updated === undefined ? refresh(store, sessionID) : store.patch(sessionID, updated)
}

export function translateSnapshotEvent(
  type: string,
  payload: V2EventPayload,
  sessionID: string,
  created: number | undefined,
  store: SnapshotStore,
): V1OutEvent[] {
  const entries = store.entries(sessionID)
  switch (type) {
    case "session.inbox.enqueued": {
      const inboxID = stringField(payload, "inboxID")
      const entry =
        inboxID === undefined || !isRecord(payload.item)
          ? undefined
          : inboxUserEntry(inboxID, payload.item, created ?? 0)
      return entry === undefined ? refresh(store, sessionID) : store.patch(sessionID, mergeEntryList(entries, entry))
    }
    case "session.inbox.delivered":
    case "session.inbox.cancelled":
    case "session.inbox.delivery.changed":
    case "session.step.first-token":
    case "session.step.streamed":
    case "session.text.started":
    case "session.text.delta":
    case "session.reasoning.started":
    case "session.reasoning.delta":
      return refresh(store, sessionID)
    case "session.step.started": {
      const messageID = stringField(payload, "assistantMessageID")
      const agent = stringField(payload, "agent")
      const started = numberField(payload, "started")
      const model = isRecord(payload.model) ? payload.model : undefined
      const modelID = model === undefined ? undefined : stringField(model, "id")
      const providerID = model === undefined ? undefined : stringField(model, "providerID")
      if (
        messageID === undefined ||
        agent === undefined ||
        started === undefined ||
        modelID === undefined ||
        providerID === undefined
      )
        return refresh(store, sessionID)
      const modelRef = { id: modelID, providerID }
      const updated = patchAssistantEntry(
        entries,
        messageID,
        (entry) => ({ ...entry, agent, model: modelRef }),
        () => stepStartedEntry(messageID, agent, modelRef, started),
      )
      return applyPatch(store, sessionID, updated)
    }
    case "session.step.ended": {
      const messageID = stringField(payload, "assistantMessageID")
      if (messageID === undefined) return refresh(store, sessionID)
      const updated = patchAssistantEntry(entries, messageID, (entry) =>
        stepEndedPatch(
          entry,
          stringField(payload, "finish"),
          numberField(payload, "cost"),
          payload.tokens,
          created ?? 0,
        ),
      )
      return applyPatch(store, sessionID, updated)
    }
    case "session.text.ended": {
      const messageID = stringField(payload, "assistantMessageID")
      const text = stringField(payload, "text")
      if (messageID === undefined || text === undefined) return refresh(store, sessionID)
      const updated = patchAssistantEntry(entries, messageID, (entry) =>
        textEndedPatch(entry, numberField(payload, "ordinal") ?? 0, text, payload.native),
      )
      return applyPatch(store, sessionID, updated)
    }
    case "session.reasoning.ended": {
      const messageID = stringField(payload, "assistantMessageID")
      const text = stringField(payload, "text")
      if (messageID === undefined || text === undefined) return refresh(store, sessionID)
      const updated = patchAssistantEntry(entries, messageID, (entry) =>
        reasoningEndedPatch(entry, numberField(payload, "ordinal") ?? 0, text, payload.native, payload.time),
      )
      return applyPatch(store, sessionID, updated)
    }
    case "session.message.content.updated": {
      const messageID = stringField(payload, "messageID")
      const content = payload.content
      if (messageID === undefined || !Array.isArray(content)) return refresh(store, sessionID)
      const updated = patchAssistantEntry(entries, messageID, (entry) => contentUpdatedPatch(entry, content))
      return applyPatch(store, sessionID, updated)
    }
    case "session.tool.input.started":
    case "session.tool.input.ended":
    case "session.tool.called":
    case "session.tool.progress":
    case "session.tool.success":
    case "session.tool.failed":
      return applyPatch(store, sessionID, translateToolSnapshotPatch(type, payload, created, entries))
    default:
      return refresh(store, sessionID)
  }
}
