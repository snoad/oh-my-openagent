import { describe, expect, it } from "bun:test"

import type { SessionMessageInfo } from "@opencode/client"
import { createEventReplay, createManualEventScheduler } from "../parity/fake-v2-event-replay"
import { createSnapshotStore } from "./snapshot-store"
import type { V1OutEvent } from "./v1-out-event"

// Snapshot diff engine of plan task 14: per-session snapshot of
// toV1Messages(ctx.session.context({ sessionID })) keyed by message id and
// part id, coalesced refreshes through an injectable scheduler, a 64-session
// LRU and dropped sessions. The diff emits message.updated,
// message.part.updated and message.removed.

const SESSION = "ses_store"

function userEntry(id: string, text: string, created = 10): SessionMessageInfo {
  return { id, type: "user", time: { created }, text, files: [] }
}

function assistantEntry(id: string, text: string): SessionMessageInfo {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { id: "gpt-fake", providerID: "openai" },
    content: [{ type: "text", text }],
    time: { created: 20, completed: 21 },
  }
}

function typesOf(events: readonly V1OutEvent[]): string[] {
  return events.map((event) => event.type)
}

describe("snapshot-store", () => {
  it("emits message.updated and message.part.updated for a new message", () => {
    // given
    const replay = createEventReplay({ sessionID: SESSION })

    // when
    const events = replay.store.patch(SESSION, [userEntry("msg_1", "hello")])

    // then
    expect(typesOf(events)).toEqual(["message.updated", "message.part.updated"])
    const info = events[0]?.properties as { info?: { id?: string; role?: string } }
    expect(info.info?.id).toBe("msg_1")
    expect(info.info?.role).toBe("user")
    const part = events[1]?.properties as { part?: { id?: string; type?: string; text?: string } }
    expect(part.part?.id).toBe("msg_1:0")
    expect(part.part?.text).toBe("hello")
  })

  it("emits nothing when the same entries are applied twice", () => {
    // given
    const replay = createEventReplay({ sessionID: SESSION })
    replay.store.patch(SESSION, [userEntry("msg_1", "hello")])

    // when
    const events = replay.store.patch(SESSION, [userEntry("msg_1", "hello")])

    // then
    expect(events).toEqual([])
  })

  it("emits message.updated when the info changes and part.updated when a part changes", () => {
    // given
    const replay = createEventReplay({ sessionID: SESSION })
    replay.store.patch(SESSION, [assistantEntry("msg_2", "first")])

    // when
    const infoChanged = replay.store.patch(SESSION, [assistantEntry("msg_2", "first"), userEntry("msg_1", "hi")])
    const partChanged = replay.store.patch(SESSION, [assistantEntry("msg_2", "second"), userEntry("msg_1", "hi")])

    // then
    expect(typesOf(infoChanged)).toEqual(["message.updated", "message.part.updated"])
    expect(typesOf(partChanged)).toEqual(["message.part.updated"])
  })

  it("emits message.removed for a message that disappeared and nothing for a removed part", () => {
    // given
    const replay = createEventReplay({ sessionID: SESSION })
    replay.store.patch(SESSION, [userEntry("msg_1", "hello"), assistantEntry("msg_2", "answer")])

    // when
    const removed = replay.store.patch(SESSION, [userEntry("msg_1", "hello")])

    // then
    expect(typesOf(removed)).toEqual(["message.removed"])
    const properties = removed[0]?.properties as { sessionID?: string; messageID?: string }
    expect(properties.messageID).toBe("msg_2")

    // and when a part disappears without the message changing
    const partGone = replay.store.patch(SESSION, [
      { ...userEntry("msg_1", "hello"), files: [] },
      {
        id: "msg_3",
        type: "assistant",
        agent: "build",
        model: { id: "m", providerID: "p" },
        content: [],
        time: { created: 5 },
      },
    ])
    expect(typesOf(partGone)).toEqual(["message.updated"])
  })

  it("coalesces N refresh requests into one context() call per batch", async () => {
    // given
    const replay = createEventReplay({ sessionID: SESSION })
    const contextCalls = () => replay.ctx.__calls.filter((call) => call.op === "session.context").length

    // when: three events arrive inside one debounce window
    replay.store.scheduleRefresh(SESSION)
    replay.store.scheduleRefresh(SESSION)
    replay.store.scheduleRefresh(SESSION)
    await replay.fire()

    // then
    expect(contextCalls()).toBe(1)
    await replay.fire()
    expect(contextCalls()).toBe(1)
  })

  it("refreshes from ctx.session.context and delivers the diff through onEvents", async () => {
    // given
    const replay = createEventReplay({ sessionID: SESSION })

    // when: the fake session store holds an entry the snapshot has not seen
    replay.pushContextEntry(userEntry("msg_new", "fresh"))
    replay.store.scheduleRefresh(SESSION)
    await replay.fire()

    // then
    expect(typesOf(replay.out)).toEqual(["message.updated", "message.part.updated"])
    const part = replay.out[1]?.properties as { part?: { id?: string } }
    expect(part.part?.id).toBe("msg_new:0")
  })

  it("drops the snapshot of a deleted session and cancels its pending refresh", async () => {
    // given
    const replay = createEventReplay({ sessionID: SESSION })
    replay.store.patch(SESSION, [userEntry("msg_1", "hello")])
    const contextCalls = () => replay.ctx.__calls.filter((call) => call.op === "session.context").length

    // when
    replay.store.scheduleRefresh(SESSION)
    replay.store.drop(SESSION)
    await replay.fire()

    // then
    expect(contextCalls()).toBe(0)
    replay.pushContextEntry(userEntry("msg_1", "hello"))
    replay.store.scheduleRefresh(SESSION)
    await replay.fire()
    expect(typesOf(replay.out)).toEqual(["message.updated", "message.part.updated"])
  })

  it("evicts the least recently used session beyond 64 cached sessions", () => {
    // given
    const ctx = createEventReplay({ sessionID: SESSION }).ctx
    const scheduler = createManualEventScheduler()
    const events: V1OutEvent[] = []
    const store = createSnapshotStore({ ctx, onEvents: (batch) => events.push(...batch), scheduler })

    // when: 65 sessions are patched
    for (let index = 0; index < 65; index += 1) {
      store.patch(`ses_${index}`, [userEntry(`msg_${index}`, `text ${index}`)])
    }

    // then: the oldest session was evicted, the newest kept
    expect(store.sessionCount()).toBe(64)
    const evicted = store.patch("ses_0", [userEntry("msg_0", "text 0")])
    expect(typesOf(evicted)).toEqual(["message.updated", "message.part.updated"])
    const kept = store.patch("ses_64", [userEntry("msg_64", "text 64")])
    expect(kept).toEqual([])
  })
})
