import { describe, expect, it } from "bun:test"

import type { SessionMessageInfo } from "@opencode/client"
import type { TextPart, ToolPart } from "@opencode-ai/sdk"

import {
  createEventReplay,
  createSyncEventReplay,
  loadFixtureContext,
  loadFixtureEvents,
  type EventReplay,
} from "../parity/fake-v2-event-replay"
import type { V1OutEvent } from "./v1-out-event"
import { isRecord, payloadOf, stringField, type V2IncomingEvent } from "./v2-event-payload"
import { translate } from "./v2-to-v1-events"

// Fixture replays of plan task 14: events-a.jsonl, events-b.jsonl and the
// events-fail-<class>.jsonl streams replayed through translate with the fake
// session store advanced between events, asserting the emitted V1 sequence
// including the tool-call lifecycle (pending, running, completed) and the
// final session.idle.

// Out-event accesses narrow through the real V1OutEvent union, failing with the actual type.
function expectOutEvent<T extends V1OutEvent["type"]>(
  event: V1OutEvent | undefined,
  type: T,
): Extract<V1OutEvent, { type: T }> {
  if (event?.type !== type) throw new Error(`expected a ${type} event, got ${String(event?.type)}`)
  return event
}

function expectTextPart(event: V1OutEvent): TextPart {
  const part = expectOutEvent(event, "message.part.updated").properties.part
  if (part.type !== "text") throw new Error(`expected a text part, got ${part.type}`)
  return part
}

function expectToolPart(event: V1OutEvent): ToolPart {
  const part = expectOutEvent(event, "message.part.updated").properties.part
  if (part.type !== "tool") throw new Error(`expected a tool part, got ${part.type}`)
  return part
}

function expectErrorPayload(event: V1OutEvent): { type: string; message: string; status: number | undefined } {
  const error = expectOutEvent(event, "session.error").properties.error
  if (!isRecord(error) || typeof error.type !== "string" || typeof error.message !== "string") {
    throw new Error("expected a structured session.error payload")
  }
  return {
    type: error.type,
    message: error.message,
    status: typeof error.status === "number" ? error.status : undefined,
  }
}

function contextEntry(name: string, index: number): SessionMessageInfo {
  const entry = loadFixtureContext(name)[index]
  if (entry === undefined) throw new Error(`fixture ${name} has no context entry at index ${String(index)}`)
  return entry
}

function firstSessionID(events: readonly V2IncomingEvent[]): string {
  const payload = payloadOf(events[0] ?? { type: "missing" })
  const sessionID = payload === undefined ? undefined : stringField(payload, "sessionID")
  if (sessionID === undefined) throw new Error("the first fixture event carries no sessionID")
  return sessionID
}

function outTypes(replay: EventReplay): string[] {
  return replay.out.map((event) => event.type)
}

async function replayFixture(name: string, advance: (replay: EventReplay, type: string) => Promise<void> | void) {
  const events = loadFixtureEvents(name)
  const replay = await createEventReplay({ sessionID: firstSessionID(events) })
  for (const event of events) {
    replay.push(event)
    await advance(replay, event.type)
  }
  return replay
}

describe("v2-to-v1-events translate", () => {
  it("replays events-a into the V1 sequence with the final session.idle", async () => {
    // given / when: the store advances at delivery and before the terminal status
    const replay = await replayFixture("events-a.jsonl", async (replayInstance, type) => {
      if (type === "session.inbox.delivered") {
        replayInstance.pushContextEntry(contextEntry("context-a.json", 0))
        await replayInstance.fire()
      }
      if (type === "session.step.started") {
        replayInstance.pushContextEntry(contextEntry("context-a.json", 1))
      }
    })
    replay.push({ type: "session.status", data: { sessionID: replay.sessionID, status: { type: "idle" } }, created: 1 })
    await replay.fire()

    // then
    expect(outTypes(replay)).toEqual([
      "session.created",
      "message.updated",
      "message.part.updated",
      "message.updated",
      "message.updated",
      "message.part.updated",
      "message.updated",
      "session.idle",
      "session.status",
    ])
    const created = expectOutEvent(replay.out[0], "session.created").properties
    expect(created.sessionID).toBe("ses_deebc9587ffe8y9bzMdQYuHocr")
    expect(created.info.id).toBe("ses_deebc9587ffe8y9bzMdQYuHocr")
    expect(created.info.title).toBe("v2 capture a")
    expect(created.info.slug).toBe("brave-planet")
    expect(created.info.time.created).toBe(1795585960572)
    const userText = expectTextPart(replay.out[2])
    expect(userText.id).toBe("msg_211436af1001kM6BdKkRZP1eCU:0")
    expect(userText.text).toBe("Reply with exactly: A_FINAL")
    const assistantText = expectTextPart(replay.out[5])
    expect(assistantText.id).toBe("msg_1")
    expect(assistantText.text).toBe("A_FINAL: plain text answer from the v2 fake model")
    const finished = expectOutEvent(replay.out[6], "message.updated").properties.info
    expect(finished.id).toBe("msg_211436c10001NWbR70eQRSWIck")
    expect(finished.role).toBe("assistant")
    expect(finished.finish).toBe("stop")
    expect(finished.cost).toBe(0)
    expect(finished.tokens?.input).toBe(10)
    expect(expectOutEvent(replay.out[7], "session.idle").properties.sessionID).toBe("ses_deebc9587ffe8y9bzMdQYuHocr")
    expect(expectOutEvent(replay.out[8], "session.status").properties.status).toEqual({ type: "idle" })
  })

  it("replays events-b with the pending, running, completed tool-call lifecycle", async () => {
    // given / when
    const replay = await replayFixture("events-b.jsonl", async (replayInstance, type) => {
      if (type === "session.inbox.delivered") {
        replayInstance.pushContextEntry(contextEntry("context-b.json", 0))
        await replayInstance.fire()
      }
      if (type === "session.execution.succeeded") {
        for (const entry of loadFixtureContext("context-b.json").slice(1)) replayInstance.pushContextEntry(entry)
      }
    })
    replay.push({ type: "session.status", data: { sessionID: replay.sessionID, status: { type: "idle" } }, created: 1 })
    await replay.fire()

    // then
    expect(outTypes(replay)).toEqual([
      "session.created",
      "message.updated",
      "message.part.updated",
      "message.updated",
      "message.updated",
      "message.part.updated",
      "message.part.updated",
      "message.part.updated",
      "message.part.updated",
      "message.updated",
      "message.updated",
      "message.part.updated",
      "message.updated",
      "session.idle",
      "session.status",
    ])
    const lifecycle = [replay.out[5], replay.out[6], replay.out[7], replay.out[8]].map((event) => {
      const part = expectToolPart(event)
      return { id: part.id, tool: part.tool, status: part.state.status }
    })
    expect(lifecycle).toEqual([
      { id: "call_1", tool: "read", status: "pending" },
      { id: "call_1", tool: "read", status: "pending" },
      { id: "call_1", tool: "read", status: "running" },
      { id: "call_1", tool: "read", status: "completed" },
    ])
    const completedState = expectToolPart(replay.out[8]).state
    if (completedState.status !== "completed") {
      throw new Error(`expected a completed tool state, got ${completedState.status}`)
    }
    expect(completedState.input).toEqual({ path: "/tmp/oqa-v2-capture.xrswdN/proj/capture-b.txt" })
    expect(completedState.output).toContain("hello v2 capture")
    expect(completedState.title).toBe("read")
    expect(completedState.metadata).toEqual({ truncated: false })
    expect(completedState.time).toEqual({ start: 1795585963898, end: 1795585963913 })
    const toolFinish = expectOutEvent(replay.out[9], "message.updated").properties.info
    expect(toolFinish.finish).toBe("tool-calls")
    const assistantText = expectTextPart(replay.out[11])
    expect(assistantText.id).toBe("msg_2")
    expect(assistantText.text).toBe("B_FINAL: the file says hello v2 capture")
  })

  it("replays every recorded failure class into V1 session.error events", async () => {
    // given / when
    const classes = ["events-fail-401.jsonl", "events-fail-429.jsonl", "events-fail-500.jsonl"]
    const results: Array<{ errorType: string; message: string; status: number | undefined }> = []
    for (const fixture of classes) {
      const replay = await replayFixture(fixture, () => {})
      const errors = replay.out.filter((event) => event.type === "session.error")
      expect(errors.length, `${fixture} should emit two session.error events`).toBe(2)
      for (const error of errors) {
        expect(error.properties.sessionID).toBe(firstSessionID(loadFixtureEvents(fixture)))
        const payload = expectErrorPayload(error)
        results.push({ errorType: payload.type, message: payload.message, status: payload.status })
      }
    }

    // then: the error payload is the identity of the V2 event, not a rebuild
    expect(results).toEqual([
      { errorType: "provider.auth", message: "v2-fake-model: invalid api key", status: 401 },
      { errorType: "provider.auth", message: "v2-fake-model: invalid api key", status: 401 },
      { errorType: "provider.rate-limit", message: "v2-fake-model: rate limited", status: 429 },
      { errorType: "provider.rate-limit", message: "v2-fake-model: rate limited", status: 429 },
      { errorType: "provider.internal", message: "v2-fake-model: internal error", status: 500 },
      { errorType: "provider.internal", message: "v2-fake-model: internal error", status: 500 },
    ])
  })

  it("passes the 400-overflow compaction failure through under its own V1-read name", async () => {
    // given / when
    const replay = await replayFixture("events-fail-400-overflow.jsonl", () => {})

    // then: the refresh scheduled by inbox.delivered never fires in this
    // replay (no fire call, empty fake context), so the third message.updated
    // is the step.started assistant patch, after the compaction passthrough
    expect(outTypes(replay)).toEqual([
      "session.created",
      "message.updated",
      "message.part.updated",
      "session.compaction.failed",
      "message.updated",
      "session.error",
      "session.error",
    ])
    expect(expectOutEvent(replay.out[4], "message.updated").properties.sessionID).toBe(
      firstSessionID(loadFixtureEvents("events-fail-400-overflow.jsonl")),
    )
    const error = expectErrorPayload(replay.out[5])
    expect(error.type).toBe("provider.invalid-request")
    expect(error.message).toContain("context")
  })

  it("drops unsubscribed and unknown V2 event types with a debug log", () => {
    // given
    const debugs: string[] = []
    const replay = createSyncEventReplay({ debug: (message) => debugs.push(message) })

    // when
    const dropped = [
      ...translate({ type: "session.renamed", data: { sessionID: "s", title: "t" } }, replay.store),
      ...translate({ type: "session.execution.succeeded", data: { sessionID: "s" } }, replay.store),
      ...translate({ type: "session.usage.updated", data: { sessionID: "s" } }, replay.store),
      ...translate({ type: "session.made.up.event", data: { sessionID: "s" } }, replay.store),
      ...translate({ type: "session.retry.scheduled", data: { sessionID: "s", attempt: 2 } }, replay.store),
    ]

    // then
    expect(dropped).toEqual([])
    expect(debugs.length).toBe(5)
    for (const message of debugs) expect(message).toContain("session.")
  })

  it("drops a session.step.failed without a provider error object", () => {
    // given
    const debugs: string[] = []
    const replay = createSyncEventReplay({ debug: (message) => debugs.push(message) })

    // when
    const events = translate(
      { type: "session.step.failed", data: { sessionID: "s", assistantMessageID: "m", error: "boom" } },
      replay.store,
    )

    // then
    expect(events).toEqual([])
    expect(debugs).toHaveLength(1)
  })

  it("drops events whose payload carries no sessionID", () => {
    // given
    const replay = createSyncEventReplay({})

    // when / then
    expect(translate({ type: "session.created", data: {} }, replay.store)).toEqual([])
    expect(
      translate({ type: "session.tool.called", data: { assistantMessageID: "m", id: "c1" } }, replay.store),
    ).toEqual([])
  })
})
