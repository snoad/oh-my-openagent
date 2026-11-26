import type { JsonValue } from "@opencode/client"

// Payload parsing for the OpenCode 2 event translation (plan task 14). The
// incoming event shape is structural: the pinned 2.4.1 stream yields
// { type, data, created, ... } and the hermetic fake ctx yields the same
// shape, so every field is read through a runtime-checked helper instead of
// a cast on the SDK event union. The payload record is JsonValue-typed so
// narrowed records assign into the client SDK's JsonValue index shapes.

export type V2IncomingEvent = {
  readonly type: string
  readonly [key: string]: unknown
}

export type V2EventPayload = Record<string, JsonValue>

export function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function payloadOf(event: V2IncomingEvent): V2EventPayload | undefined {
  const data = event.data
  return isRecord(data) ? data : undefined
}

export function stringField(payload: V2EventPayload, key: string): string | undefined {
  const value = payload[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function numberField(payload: V2EventPayload, key: string): number | undefined {
  const value = payload[key]
  return typeof value === "number" ? value : undefined
}

export function createdOf(event: V2IncomingEvent): number | undefined {
  const created = event.created
  return typeof created === "number" ? created : undefined
}
