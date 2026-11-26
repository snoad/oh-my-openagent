import type { Hooks } from "@opencode-ai/plugin"

import { subscribeV2RawEvents, type V2EventSubscriptionContext } from "../events/subscribe-v2-events"
import { isRecord, payloadOf, stringField, type V2EventPayload, type V2IncomingEvent } from "../events/v2-event-payload"
import type { CompactionAutocontinueHook } from "../../plugin/session-compacting"
import { sessionHookTarget } from "./adapt-prompt-hook"
import { markHook } from "../runtime/hook-markers"
import type { V2RuntimePluginContext } from "../runtime/start-v2-runtime"
import type { V2Runtime } from "../runtime/stop-v2-runtime"

// Compaction adapter (plan task 19). OpenCode 2 reports the compaction
// lifecycle as raw events whose payloads the V1 translation drops, so the
// raw subscription drives both V1 halves: session.compaction.started runs
// engine["experimental.session.compacting"] (capture + context injection)
// and session.compaction.ended drives the restore half exactly once through
// engine["experimental.compaction.autocontinue"] with the finished summary
// resolved from the event payload (ctx.session.compact returns the admitted
// inbox item, not the summary). The session compaction hook feeds the
// captured context into the compaction request by appending text parts to
// event.system; result is never set, because setting it would skip the model
// request. A live check that the host ignores an edited system lands in
// LIM-12 (live row L-25, task 20).

export type V2CompactionSystemPart = { type: string; text: string }

export type V2CompactionHookEvent = {
  readonly sessionID: string
  readonly system: V2CompactionSystemPart[]
  result?: unknown
}

const capturedContext = new Map<string, string[]>()
const restoredSessions = new Set<string>()

export function resetCompactionAdaptationStateForTesting(): void {
  capturedContext.clear()
  restoredSessions.clear()
}

function summaryOf(payload: V2EventPayload): string | undefined {
  const direct = stringField(payload, "summary")
  if (direct !== undefined) return direct
  const result = payload["result"]
  return isRecord(result) ? stringField(result, "summary") : undefined
}

async function onCompactionStarted(runtime: V2Runtime, event: V2IncomingEvent): Promise<void> {
  const payload = payloadOf(event)
  if (payload === undefined) return
  const sessionID = stringField(payload, "sessionID")
  if (sessionID === undefined) return
  markHook("experimental.session.compacting", sessionID)
  const output: { context: string[]; prompt?: string } = { context: [] }
  await runtime.engine["experimental.session.compacting"]?.({ sessionID }, output)
  capturedContext.set(sessionID, [...output.context])
  restoredSessions.delete(sessionID)
}

async function onCompactionEnded(runtime: V2Runtime, event: V2IncomingEvent): Promise<void> {
  const payload = payloadOf(event)
  if (payload === undefined) return
  const sessionID = stringField(payload, "sessionID")
  if (sessionID === undefined) return
  if (restoredSessions.has(sessionID)) return
  restoredSessions.add(sessionID)
  const summary = summaryOf(payload)
  markHook("experimental.compaction.autocontinue", sessionID)
  const autocontinue = runtime.engine["experimental.compaction.autocontinue"] as unknown as
    CompactionAutocontinueHook | undefined
  await autocontinue?.({ sessionID, ...(summary === undefined ? {} : { message: summary }) }, { enabled: false })
  capturedContext.delete(sessionID)
}

async function onCompactionFailed(event: V2IncomingEvent): Promise<void> {
  const payload = payloadOf(event)
  if (payload === undefined) return
  const sessionID = stringField(payload, "sessionID")
  if (sessionID === undefined) return
  capturedContext.delete(sessionID)
  restoredSessions.delete(sessionID)
}

export async function registerCompactionHookAdapters(input: {
  readonly ctx: V2RuntimePluginContext
  readonly runtime: V2Runtime
}): Promise<void> {
  const hookCtx = sessionHookTarget(input.ctx)
  await hookCtx.session.hook("compaction", (event: V2CompactionHookEvent) => {
    markHook("compaction", event.sessionID)
    const captured = capturedContext.get(event.sessionID)
    if (captured === undefined) return
    for (const text of captured) event.system.push({ type: "text", text })
  })
  const rawCtx = input.ctx as V2RuntimePluginContext & V2EventSubscriptionContext
  const runtime = input.runtime
  subscribeV2RawEvents(
    rawCtx,
    [
      { types: ["session.compaction.started"], onEvent: (event) => onCompactionStarted(runtime, event) },
      {
        types: ["session.compaction.ended"],
        onEvent: (event) => onCompactionEnded(runtime, event),
      },
      { types: ["session.compaction.failed"], onEvent: (event) => onCompactionFailed(event) },
    ],
    { signal: runtime.abort.signal },
  )
}
