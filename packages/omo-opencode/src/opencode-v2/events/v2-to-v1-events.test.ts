import { describe, expect, it } from "bun:test"

import {
  createEventReplay,
  createSyncEventReplay,
  loadFixtureContext,
  loadFixtureEvents,
  type EventReplay,
} from "../parity/fake-v2-event-replay"
import type { V1OutEvent } from "./v1-out-event"
import { translate } from "./v2-to-v1-events"

// Fixture replays of plan task 14: events-a.jsonl, events-b.jsonl and the
// events-fail-<class>.jsonl streams replayed through translate with the fake
// session store advanced between events, asserting the emitted V1 sequence
// including the tool-call lifecycle (pending, running, completed) and the
// final session.idle.

type Properties = Record<string, any>

function outTypes(replay: EventReplay): string[] {
  return replay.out.map((event) => event.type)
}

function propertiesOf(event: V1OutEvent | undefined): Properties {
  return (event?.properties ?? {}) as Properties
}

async function replayFixture(name: string, advance: (replay: EventReplay, type: string) => Promise<void> | void) {
  const events = loadFixtureEvents(name)
  const sessionID = (events[0]?.data as Properties | undefined)?.sessionID as string
  const replay = await createEventReplay({ sessionID })
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
        replayInstance.pushContextEntry(loadFixtureContext("context-a.json")[0]!)
        await replayInstance.fire()
      }
      if (type === "session.step.started") {
        replayInstance.pushContextEntry(loadFixtureContext("context-a.json")[1]!)
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
    const created = propertiesOf(replay.out[0])
    expect(created.sessionID).toBe("ses_deebc9587ffe8y9bzMdQYuHocr")
    expect(created.info.id).toBe("ses_deebc9587ffe8y9bzMdQYuHocr")
    expect(created.info.title).toBe("v2 capture a")
    expect(created.info.slug).toBe("brave-planet")
    expect(created.info.time.created).toBe(1795585960572)
    const userText = propertiesOf(replay.out[2]).part as Properties
    expect(userText.id).toBe("msg_211436af1001kM6BdKkRZP1eCU:0")
    expect(userText.text).toBe("Reply with exactly: A_FINAL")
    const assistantText = propertiesOf(replay.out[5]).part as Properties
    expect(assistantText.id).toBe("msg_1")
    expect(assistantText.text).toBe("A_FINAL: plain text answer from the v2 fake model")
    const finished = propertiesOf(replay.out[6]).info as Properties
    expect(finished.id).toBe("msg_211436c10001NWbR70eQRSWIck")
    expect(finished.role).toBe("assistant")
    expect(finished.finish).toBe("stop")
    expect(finished.cost).toBe(0)
    expect(finished.tokens.input).toBe(10)
    expect(propertiesOf(replay.out[7]).sessionID).toBe("ses_deebc9587ffe8y9bzMdQYuHocr")
    expect(propertiesOf(replay.out[8]).status).toEqual({ type: "idle" })
  })

  it("replays events-b with the pending, running, completed tool-call lifecycle", async () => {
    // given / when
    const replay = await replayFixture("events-b.jsonl", async (replayInstance, type) => {
      if (type === "session.inbox.delivered") {
        replayInstance.pushContextEntry(loadFixtureContext("context-b.json")[0]!)
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
      const part = propertiesOf(event).part as Properties
      return { id: part.id, tool: part.tool, status: part.state.status }
    })
    expect(lifecycle).toEqual([
      { id: "call_1", tool: "read", status: "pending" },
      { id: "call_1", tool: "read", status: "pending" },
      { id: "call_1", tool: "read", status: "running" },
      { id: "call_1", tool: "read", status: "completed" },
    ])
    const completed = propertiesOf(replay.out[8]).part as Properties
    expect(completed.state.input).toEqual({ path: "/tmp/oqa-v2-capture.xrswdN/proj/capture-b.txt" })
    expect(completed.state.output).toContain("hello v2 capture")
    expect(completed.state.title).toBe("read")
    expect(completed.state.metadata).toEqual({ truncated: false })
    expect(completed.state.time).toEqual({ start: 1795585963898, end: 1795585963913 })
    const toolFinish = propertiesOf(replay.out[9]).info as Properties
    expect(toolFinish.finish).toBe("tool-calls")
    const assistantText = propertiesOf(replay.out[11]).part as Properties
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
        const properties = propertiesOf(error)
        expect(properties.sessionID).toBe((loadFixtureEvents(fixture)[0]?.data as Properties).sessionID)
        results.push({
          errorType: (properties.error as Properties).type,
          message: (properties.error as Properties).message,
          status: (properties.error as Properties).status,
        })
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
    expect(propertiesOf(replay.out[4]).sessionID).toBe(
      (loadFixtureEvents("events-fail-400-overflow.jsonl")[0]?.data as Properties).sessionID,
    )
    const error = propertiesOf(replay.out[5]).error as Properties
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
