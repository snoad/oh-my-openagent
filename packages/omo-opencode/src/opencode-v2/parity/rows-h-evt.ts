import { expect } from "./bun-test-shim"

import type { SessionMessageInfo } from "@opencode/client"
import { translate } from "../events/v2-to-v1-events"
import { createSyncEventReplay } from "./fake-v2-event-replay"
import { defineGroup, type ParityRow, type ParityRowGroupItem } from "./rows"

// Wave-2 H-EVT rows (plan task 14): one row per V1 event catalog entry the
// translation synthesizes or passes through, each driving translate over
// the hermetic replay harness and asserting the emitted V1 sequence. The
// ignored catalog entries and the coalescing performance row live in
// rows-h-evt-ignored.ts; both files feed the H-EVT id space.

const SESSION = "ses_h_evt"

function userEntry(id: string, text: string): SessionMessageInfo {
  return { id, type: "user", time: { created: 10 }, text, files: [] }
}

function row(suffix: string, title: string, check: () => void | Promise<void>): ParityRowGroupItem {
  return { suffix, title, kind: "hermetic", is: ["IS-4", "IS-8"], wave: 2, status: "checked", check }
}

function checkCreated(): void {
  const replay = createSyncEventReplay({})
  const events = translate(
    {
      type: "session.created",
      created: 5,
      data: { sessionID: SESSION, slug: "brave-planet", title: "t0", version: "2.4.1" },
    },
    replay.store,
  )
  expect(events.map((event) => event.type)).toEqual(["session.created"])
  const info = (events[0]?.properties as { info?: { id?: string; slug?: string; title?: string } }).info
  expect(info?.id).toBe(SESSION)
  expect(info?.slug).toBe("brave-planet")
  expect(info?.title).toBe("t0")
  translate({ type: "session.renamed", created: 6, data: { sessionID: SESSION, title: "renamed title" } }, replay.store)
  expect(info?.title).toBe("renamed title")
}

function checkDeleted(): void {
  const replay = createSyncEventReplay({})
  replay.store.patch(SESSION, [userEntry("msg_1", "hi")])
  expect(replay.store.sessionCount()).toBe(1)
  const events = translate({ type: "session.deleted", created: 6, data: { sessionID: SESSION } }, replay.store)
  expect(events.map((event) => event.type)).toEqual(["session.deleted"])
  expect((events[0]?.properties as { info?: { id?: string } }).info?.id).toBe(SESSION)
  expect(replay.store.sessionCount()).toBe(0)
}

function checkIdle(): void {
  const replay = createSyncEventReplay({})
  const events = translate(
    { type: "session.status", created: 5, data: { sessionID: SESSION, status: { type: "idle" } } },
    replay.store,
  )
  expect(events.map((event) => event.type)).toEqual(["session.idle", "session.status"])
  const deprecated = translate({ type: "session.idle", created: 6, data: { sessionID: SESSION } }, replay.store)
  expect(deprecated.map((event) => event.type)).toEqual(["session.idle"])
}

function checkStatus(): void {
  const replay = createSyncEventReplay({})
  const events = translate(
    {
      type: "session.status",
      created: 5,
      data: { sessionID: SESSION, status: { type: "retry", attempt: 2, next: 1000 } },
    },
    replay.store,
  )
  expect(events.map((event) => event.type)).toEqual(["session.status"])
  expect((events[0]?.properties as { status?: { attempt?: number } }).status?.attempt).toBe(2)
}

function checkError(): void {
  const replay = createSyncEventReplay({})
  const error = { type: "provider.auth", message: "invalid api key", status: 401 }
  const execution = translate(
    { type: "session.execution.failed", created: 5, data: { sessionID: SESSION, error } },
    replay.store,
  )
  const step = translate({ type: "session.step.failed", created: 6, data: { sessionID: SESSION, error } }, replay.store)
  for (const events of [execution, step]) {
    expect(events.map((event) => event.type)).toEqual(["session.error"])
    expect((events[0]?.properties as { error?: unknown }).error).toBe(error)
  }
  const debugs: string[] = []
  const observed = createSyncEventReplay({ debug: (message) => debugs.push(message) })
  expect(
    translate({ type: "session.step.failed", created: 7, data: { sessionID: SESSION, error: "boom" } }, observed.store),
  ).toEqual([])
  expect(debugs.some((message) => message.includes("session.step.failed"))).toBe(true)
}

function checkCompactionPassthrough(type: "session.compaction.ended" | "session.compaction.failed"): void {
  const replay = createSyncEventReplay({})
  const events = translate({ type, created: 5, data: { sessionID: SESSION } }, replay.store)
  expect(events.map((event) => event.type)).toEqual([type])
  expect((events[0]?.properties as { sessionID?: string }).sessionID).toBe(SESSION)
}

function checkMessageUpdated(): void {
  const replay = createSyncEventReplay({})
  const events = translate(
    {
      type: "session.inbox.enqueued",
      created: 5,
      data: {
        sessionID: SESSION,
        inboxID: "msg_1",
        item: { type: "user", delivery: "steer", payload: { text: "hi" } },
      },
    },
    replay.store,
  )
  expect(events.map((event) => event.type)).toEqual(["message.updated", "message.part.updated"])
  const info = (events[0]?.properties as { info?: { id?: string; role?: string } }).info
  expect(info?.id).toBe("msg_1")
  expect(info?.role).toBe("user")
}

function checkMessagePartUpdated(): void {
  const replay = createSyncEventReplay({})
  translate(
    {
      type: "session.step.started",
      created: 5,
      data: {
        sessionID: SESSION,
        assistantMessageID: "msg_a",
        agent: "build",
        model: { id: "m", providerID: "p" },
        started: 5,
      },
    },
    replay.store,
  )
  const events = translate(
    {
      type: "session.tool.input.started",
      created: 6,
      data: { sessionID: SESSION, assistantMessageID: "msg_a", id: "call_1", name: "read" },
    },
    replay.store,
  )
  expect(events.map((event) => event.type)).toEqual(["message.part.updated"])
  const part = (events[0]?.properties as { part?: { id?: string; tool?: string; state?: { status?: string } } }).part
  expect(part?.id).toBe("call_1")
  expect(part?.tool).toBe("read")
  expect(part?.state?.status).toBe("pending")
}

function checkMessageRemoved(): void {
  const replay = createSyncEventReplay({})
  replay.store.patch(SESSION, [userEntry("msg_1", "a"), userEntry("msg_2", "b")])
  const events = replay.store.patch(SESSION, [userEntry("msg_1", "a")])
  expect(events.map((event) => event.type)).toEqual(["message.removed"])
  expect((events[0]?.properties as { messageID?: string }).messageID).toBe("msg_2")
}

export const hEvtRows: ParityRow[] = defineGroup("H-EVT", [
  row("CREATED", "session.created passes through and session.renamed merges the title", checkCreated),
  row("DELETED", "session.deleted passes through and drops the session snapshot", checkDeleted),
  row(
    "IDLE",
    "session.status idle emits session.idle and session.status; the deprecated session.idle passes through",
    checkIdle,
  ),
  row("STATUS", "session.status with a non-idle status emits session.status only", checkStatus),
  row(
    "ERROR",
    "session.execution.failed and session.step.failed synthesize session.error with the payload identity",
    checkError,
  ),
  row("COMPACTION-ENDED", "session.compaction.ended passes through under its own name", () =>
    checkCompactionPassthrough("session.compaction.ended"),
  ),
  row("COMPACTION-FAILED", "session.compaction.failed passes through under its own name", () =>
    checkCompactionPassthrough("session.compaction.failed"),
  ),
  row(
    "MESSAGE-UPDATED",
    "a new message from the inbox patch emits message.updated with the payload identity",
    checkMessageUpdated,
  ),
  row(
    "MESSAGE-PART-UPDATED",
    "the tool-call part lifecycle emits message.part.updated with pending status",
    checkMessagePartUpdated,
  ),
  row("MESSAGE-REMOVED", "a message that disappeared emits message.removed", checkMessageRemoved),
])
