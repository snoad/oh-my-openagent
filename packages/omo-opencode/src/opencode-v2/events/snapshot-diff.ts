import type { V1MessageWithParts } from "../client/shape-codec-types"
import type { V1OutEvent } from "./v1-out-event"

// Snapshot diff of two V1 message mirrors (plan task 14). message.updated is
// emitted for new messages and changed infos, message.part.updated for new
// and changed parts, message.removed for messages that disappeared. A part
// that disappears from a surviving message emits nothing: the engine's V1
// stream has no part-removal event the OpenCode 2 stream can produce (the
// catalog documents message.part.removed as ignored).

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length && keys.every((key) => deepEqual(left[key], right[key]))
  }
  return false
}

export function diffSnapshots(
  sessionID: string,
  previous: readonly V1MessageWithParts[],
  next: readonly V1MessageWithParts[],
): V1OutEvent[] {
  const events: V1OutEvent[] = []
  const previousById = new Map(previous.map((message) => [message.info.id, message] as const))
  for (const message of next) {
    const old = previousById.get(message.info.id)
    if (old === undefined || !deepEqual(old.info, message.info)) {
      events.push({ type: "message.updated", properties: { sessionID, info: message.info } })
    }
    const oldParts = new Map((old?.parts ?? []).map((part) => [part.id, part] as const))
    for (const part of message.parts) {
      const oldPart = oldParts.get(part.id)
      if (oldPart === undefined || !deepEqual(oldPart, part)) {
        events.push({ type: "message.part.updated", properties: { sessionID, part, time: Date.now() } })
      }
    }
  }
  const nextIds = new Set(next.map((message) => message.info.id))
  for (const message of previous) {
    if (!nextIds.has(message.info.id)) {
      events.push({ type: "message.removed", properties: { sessionID, messageID: message.info.id } })
    }
  }
  return events
}
