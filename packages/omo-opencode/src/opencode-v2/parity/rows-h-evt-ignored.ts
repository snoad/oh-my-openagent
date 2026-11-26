import { expect } from "./bun-test-shim"

import type { SessionMessageInfo } from "@opencode/client"
import { translate } from "../events/v2-to-v1-events"
import { V1_EVENT_CATALOG } from "../events/v1-event-catalog"
import { createSyncEventReplay } from "./fake-v2-event-replay"
import { defineGroup, type ParityRow, type ParityRowGroupItem } from "./rows"

// Wave-2 H-EVT ignored rows (plan task 14): one row per catalog entry the
// OpenCode 2 event stream cannot produce, each pinning the catalog entry
// (mode ignored, no v2 source) and a behavioral probe that no translation
// emits the V1 name. The tool-lifecycle rows live in
// rows-h-evt-ignored-tool.ts and the coalescing performance row in
// rows-h-evt-performance.ts; all files feed the H-EVT id space.

const SESSION = "ses_h_evt_ignored"

function row(suffix: string, title: string, check: () => void | Promise<void>): ParityRowGroupItem {
  return { suffix, title, kind: "hermetic", is: ["IS-4", "IS-8"], wave: 2, status: "checked", check }
}

export function checkIgnoredEntry(v1Type: string, emitted: readonly string[]): void {
  const entry = V1_EVENT_CATALOG[v1Type]
  expect(entry?.mode, `${v1Type} catalog mode`).toBe("ignored")
  expect(entry?.v2Sources.length ?? 1, `${v1Type} has no v2 source`).toBe(0)
  for (const type of emitted) expect(type, `${v1Type} is never emitted`).not.toBe(v1Type)
}

function checkMessagePartDelta(): void {
  const replay = createSyncEventReplay({})
  const events = translate(
    {
      type: "session.text.delta",
      created: 5,
      data: { sessionID: SESSION, assistantMessageID: "msg_a", delta: "x", ordinal: 0 },
    },
    replay.store,
  )
  checkIgnoredEntry(
    "message.part.delta",
    events.map((event) => event.type),
  )
}

function checkMessagePartRemoved(): void {
  const replay = createSyncEventReplay({})
  const withText: SessionMessageInfo = {
    id: "msg_2",
    type: "assistant",
    agent: "build",
    model: { id: "m", providerID: "p" },
    content: [{ type: "text", text: "first" }],
    time: { created: 20, completed: 21 },
  }
  replay.store.patch(SESSION, [withText])
  const events = replay.store.patch(SESSION, [{ ...withText, content: [] }])
  checkIgnoredEntry(
    "message.part.removed",
    events.map((event) => event.type),
  )
}

function checkCompacted(): void {
  const replay = createSyncEventReplay({})
  const events = translate(
    { type: "session.compaction.failed", created: 5, data: { sessionID: SESSION } },
    replay.store,
  )
  checkIgnoredEntry(
    "session.compacted",
    events.map((event) => event.type),
  )
}

function checkStop(): void {
  const replay = createSyncEventReplay({})
  const idle = translate(
    { type: "session.status", created: 5, data: { sessionID: SESSION, status: { type: "idle" } } },
    replay.store,
  )
  const failed = translate(
    { type: "session.execution.failed", created: 6, data: { sessionID: SESSION, error: { type: "t", message: "m" } } },
    replay.store,
  )
  checkIgnoredEntry(
    "session.stop",
    [...idle, ...failed].map((event) => event.type),
  )
}

function checkNextRetried(): void {
  const debugs: string[] = []
  const replay = createSyncEventReplay({ debug: (message) => debugs.push(message) })
  const events = translate(
    { type: "session.retry.scheduled", created: 5, data: { sessionID: SESSION, attempt: 2 } },
    replay.store,
  )
  checkIgnoredEntry(
    "session.next.retried",
    events.map((event) => event.type),
  )
  expect(debugs.some((message) => message.includes("session.retry.scheduled"))).toBe(true)
}

export const hEvtIgnoredRows: ParityRow[] = defineGroup("H-EVT", [
  row(
    "MESSAGE-PART-DELTA",
    "message.part.delta is never emitted; streaming deltas only schedule a refresh",
    checkMessagePartDelta,
  ),
  row(
    "MESSAGE-PART-REMOVED",
    "message.part.removed is never emitted; a disappearing part emits nothing",
    checkMessagePartRemoved,
  ),
  row(
    "COMPACTED",
    "session.compacted is never emitted; the V2 compaction events pass under their own names",
    checkCompacted,
  ),
  row("STOP", "session.stop is never emitted; terminal signals arrive as session.status and session.error", checkStop),
  row("TODO-UPDATED", "todo.updated has no OpenCode 2 source", () => checkIgnoredEntry("todo.updated", [])),
  row(
    "NEXT-RETRIED",
    "session.next.retried is never emitted; session.retry.scheduled is dropped with a debug log",
    checkNextRetried,
  ),
  row("NEXT-SYNTHETIC", "session.next.synthetic has no OpenCode 2 source", () =>
    checkIgnoredEntry("session.next.synthetic", []),
  ),
])
