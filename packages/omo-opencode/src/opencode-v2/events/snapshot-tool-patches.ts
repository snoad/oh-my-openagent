import type { JsonValue, SessionMessageInfo } from "@opencode/client"

import { patchAssistantEntry } from "./snapshot-entries"
import {
  toolCalledPatch,
  toolFailedPatch,
  toolInputEndedPatch,
  toolInputStartedPatch,
  toolProgressPatch,
  toolSuccessPatch,
} from "./snapshot-tool-parts"
import { isRecord, stringField, type V2EventPayload } from "./v2-event-payload"

// Tool-call routing of the snapshot-diff V2 sources (plan task 14): the
// session.tool.* lifecycle mapped onto the tool part merges. The returned
// patch result is undefined when the payload lacks the identity a V1
// consumer reads, which tells the caller to schedule a context() refresh.

function booleanField(payload: V2EventPayload, key: string): boolean | undefined {
  const value = payload[key]
  return typeof value === "boolean" ? value : undefined
}

function metadataField(payload: V2EventPayload): Record<string, JsonValue> | undefined {
  return isRecord(payload.metadata) ? payload.metadata : undefined
}

export function translateToolSnapshotPatch(
  type: string,
  payload: V2EventPayload,
  created: number | undefined,
  entries: readonly SessionMessageInfo[],
): readonly SessionMessageInfo[] | undefined {
  switch (type) {
    case "session.tool.input.started": {
      const messageID = stringField(payload, "assistantMessageID")
      const callID = stringField(payload, "id")
      const name = stringField(payload, "name")
      if (messageID === undefined || callID === undefined || name === undefined) return undefined
      return patchAssistantEntry(entries, messageID, (entry) =>
        toolInputStartedPatch(entry, callID, name, created ?? 0),
      )
    }
    case "session.tool.input.ended": {
      const messageID = stringField(payload, "assistantMessageID")
      const callID = stringField(payload, "id")
      const text = stringField(payload, "text")
      if (messageID === undefined || callID === undefined || text === undefined) return undefined
      return patchAssistantEntry(entries, messageID, (entry) => toolInputEndedPatch(entry, callID, text))
    }
    case "session.tool.called": {
      const messageID = stringField(payload, "assistantMessageID")
      const callID = stringField(payload, "id")
      const input = isRecord(payload.input) ? payload.input : undefined
      if (messageID === undefined || callID === undefined || input === undefined) return undefined
      return patchAssistantEntry(entries, messageID, (entry) =>
        toolCalledPatch(entry, callID, input, payload.native, booleanField(payload, "executed"), created ?? 0),
      )
    }
    case "session.tool.progress": {
      const messageID = stringField(payload, "assistantMessageID")
      const callID = stringField(payload, "id")
      const metadata = metadataField(payload)
      if (messageID === undefined || callID === undefined || metadata === undefined) return undefined
      return patchAssistantEntry(entries, messageID, (entry) => toolProgressPatch(entry, callID, metadata))
    }
    case "session.tool.success": {
      const messageID = stringField(payload, "assistantMessageID")
      const callID = stringField(payload, "id")
      const content = payload.content
      if (messageID === undefined || callID === undefined || !Array.isArray(content)) return undefined
      return patchAssistantEntry(entries, messageID, (entry) =>
        toolSuccessPatch(
          entry,
          callID,
          content,
          booleanField(payload, "executed"),
          metadataField(payload),
          created ?? 0,
        ),
      )
    }
    case "session.tool.failed": {
      const messageID = stringField(payload, "assistantMessageID")
      const callID = stringField(payload, "id")
      const error = payload.error
      if (messageID === undefined || callID === undefined || !isRecord(error)) return undefined
      return patchAssistantEntry(entries, messageID, (entry) =>
        toolFailedPatch(entry, callID, error, metadataField(payload), created ?? 0),
      )
    }
    default:
      return undefined
  }
}
