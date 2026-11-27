import type { SnapshotStore } from "./snapshot-store"
import { translateSnapshotEvent } from "./snapshot-event-patches"
import { isSnapshotDiffV2Source } from "./v1-event-catalog"
import type { V1OutEvent, V1StatusOut, WritableV1SessionInfo } from "./v1-out-event"
import {
  createdOf,
  isRecord,
  payloadOf,
  stringField,
  type V2EventPayload,
  type V2IncomingEvent,
} from "./v2-event-payload"

// translate (plan task 14): maps one OpenCode 2 event onto the V1 events the
// engine consumes. Identity-first: session, message and part ids, tool
// names, statuses and error objects come from the event payload whenever it
// carries a field a V1 consumer reads; a payload that lacks them schedules a
// coalesced context() fetch through the snapshot store. Every translation
// needs the sessionID the payload carries; everything the catalog does not
// subscribe to is dropped with a debug log.

export function translate(v2Event: V2IncomingEvent, snapshots: SnapshotStore): V1OutEvent[] {
  const type = v2Event.type
  const payload = payloadOf(v2Event)
  if (payload === undefined) return drop(snapshots, type, "carries no payload")
  const sessionID = stringField(payload, "sessionID")
  if (sessionID === undefined) return drop(snapshots, type, "carries no sessionID")
  switch (type) {
    case "session.created":
      return sessionCreated(payload, sessionID, createdOf(v2Event) ?? 0, snapshots)
    case "session.renamed":
      return sessionRenamed(payload, sessionID, snapshots)
    case "session.deleted":
      snapshots.drop(sessionID)
      return [{ type: "session.deleted", properties: { sessionID, info: { id: sessionID } } }]
    case "session.status":
      return sessionStatus(payload, sessionID, snapshots)
    case "session.idle":
      return [{ type: "session.idle", properties: { sessionID } }]
    case "session.execution.failed":
      return [{ type: "session.error", properties: { sessionID, error: payload.error } }]
    case "session.step.failed":
      return isStructuredError(payload.error)
        ? [{ type: "session.error", properties: { sessionID, error: payload.error } }]
        : drop(snapshots, type, "carries no provider error object")
    case "session.compaction.ended":
    case "session.compaction.failed":
      return [{ type, properties: { sessionID } }]
    default:
      if (!isSnapshotDiffV2Source(type)) return drop(snapshots, type, "is not a v1 catalog source")
      return translateSnapshotEvent(type, payload, sessionID, createdOf(v2Event), snapshots)
  }
}

function sessionCreated(
  payload: V2EventPayload,
  sessionID: string,
  created: number,
  snapshots: SnapshotStore,
): V1OutEvent[] {
  const title = stringField(payload, "title")
  const slug = stringField(payload, "slug")
  const projectID = stringField(payload, "projectID")
  const version = stringField(payload, "version")
  const parentID = stringField(payload, "parentID")
  const directory = isRecord(payload.location) ? stringField(payload.location, "directory") : undefined
  const info: WritableV1SessionInfo = {
    id: sessionID,
    sessionID,
    ...(title === undefined ? {} : { title }),
    ...(slug === undefined ? {} : { slug }),
    ...(projectID === undefined ? {} : { projectID }),
    ...(version === undefined ? {} : { version }),
    ...(parentID === undefined ? {} : { parentID }),
    ...(directory === undefined ? {} : { directory }),
    time: { created },
  }
  snapshots.putSessionInfo(sessionID, info)
  return [{ type: "session.created", properties: { sessionID, info } }]
}

function sessionRenamed(payload: V2EventPayload, sessionID: string, snapshots: SnapshotStore): V1OutEvent[] {
  const title = stringField(payload, "title")
  if (title !== undefined) snapshots.renameSession(sessionID, title)
  snapshots.debug(`[v2-events] session.renamed merged the title of ${sessionID} into the session info registry`)
  return []
}

function sessionStatus(payload: V2EventPayload, sessionID: string, snapshots: SnapshotStore): V1OutEvent[] {
  const status = isRecord(payload.status) ? (payload.status as V1StatusOut) : undefined
  if (status === undefined) return drop(snapshots, "session.status", "carries no status")
  const events: V1OutEvent[] = [{ type: "session.status", properties: { sessionID, status } }]
  if (status.type === "idle") events.unshift({ type: "session.idle", properties: { sessionID } })
  return events
}

function isStructuredError(value: unknown): boolean {
  return isRecord(value) && typeof value.type === "string" && typeof value.message === "string"
}

function drop(snapshots: SnapshotStore, type: string, reason: string): V1OutEvent[] {
  snapshots.debug(`[v2-events] dropped ${type}: ${reason}`)
  return []
}
