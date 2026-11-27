import { describe, expect, it } from "bun:test"

import { createFakeV2Context } from "../parity/fake-v2-context"
import { createManualEventScheduler } from "../parity/fake-v2-event-replay"
import { formatV2EventStats, type V2EventStats } from "./event-stats"
import { subscribeV2Events, type V2EventSubscriptionContext } from "./subscribe-v2-events"
import type { V1OutEvent } from "./v1-out-event"
import type { V2IncomingEvent } from "./v2-event-payload"

// Subscription loop of plan task 14: ctx.event.subscribe({ types: <all
// catalog sources>, signal }), per event translate then await onV1Event for
// each result inside try/catch with error isolation, and a stop() that aborts
// and awaits loop completion through an injectable timeout.

type Properties = Record<string, any>

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function subscriptionTypes(ctx: { __calls: readonly { op: string; args: readonly unknown[] }[] }): string[] {
  const call = ctx.__calls.find((entry) => entry.op === "event.subscribe")
  return ((call?.args[0] as Properties | undefined)?.types ?? []) as string[]
}

describe("subscribeV2Events", () => {
  it("subscribes with the catalog sources and delivers translated events", async () => {
    // given
    const ctx = createFakeV2Context()
    const delivered: V1OutEvent[] = []
    const subscription = subscribeV2Events(ctx, ({ event }) => {
      delivered.push(event)
    })

    // when
    try {
      ctx.__pushEvent({
        type: "session.created",
        created: 5,
        data: {
          sessionID: "ses_1",
          projectID: "prj",
          location: { directory: "/tmp/x" },
          slug: "s",
          title: "t",
          version: "2.4.1",
        },
      })
      await flushAsync()
    } finally {
      await subscription.stop()
    }

    // then
    expect(subscriptionTypes(ctx)).toContain("session.status")
    expect(subscriptionTypes(ctx)).toContain("session.tool.called")
    expect(subscriptionTypes(ctx)).toContain("session.execution.failed")
    expect(delivered.map((event) => event.type)).toEqual(["session.created"])
    expect((delivered[0]?.properties as Properties).info.id).toBe("ses_1")
  })

  it("isolates a failing V1 handler and keeps delivering later events", async () => {
    // given
    const ctx = createFakeV2Context()
    const delivered: string[] = []
    const logs: string[] = []
    const subscription = subscribeV2Events(
      ctx,
      ({ event }) => {
        if (event.type === "session.created") throw new Error("handler boom")
        delivered.push(event.type)
      },
      { debug: (message) => logs.push(message) },
    )

    // when
    try {
      ctx.__pushEvent({ type: "session.created", created: 5, data: { sessionID: "ses_1" } })
      await flushAsync()
      ctx.__pushEvent({ type: "session.deleted", created: 6, data: { sessionID: "ses_1" } })
      await flushAsync()
    } finally {
      await subscription.stop()
    }

    // then
    expect(delivered).toEqual(["session.deleted"])
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.some((message) => message.includes("handler"))).toBe(true)
  })

  it("isolates a failing translation and keeps delivering later events", async () => {
    // given
    const ctx = createFakeV2Context()
    const delivered: string[] = []
    const logs: string[] = []
    const subscription = subscribeV2Events(
      ctx,
      ({ event }) => {
        delivered.push(event.type)
      },
      { debug: (message) => logs.push(message) },
    )

    // when: step.started creates the assistant entry, then a malformed
    // content update makes the codec throw inside translate
    try {
      ctx.__pushEvent({
        type: "session.step.started",
        created: 5,
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_1",
          agent: "build",
          model: { id: "m", providerID: "p" },
          started: 5,
        },
      })
      await flushAsync()
      ctx.__pushEvent({
        type: "session.message.content.updated",
        created: 6,
        data: { sessionID: "ses_1", messageID: "msg_1", content: [{ type: "not-a-part" }] },
      })
      await flushAsync()
      ctx.__pushEvent({ type: "session.deleted", created: 7, data: { sessionID: "ses_1" } })
      await flushAsync()
    } finally {
      await subscription.stop()
    }

    // then
    expect(delivered).toEqual(["message.updated", "session.deleted"])
    expect(logs.some((message) => message.includes("translation"))).toBe(true)
  })

  it("drops a session.step.failed without a provider error and never crashes the loop", async () => {
    // given
    const ctx = createFakeV2Context()
    const delivered: string[] = []
    const logs: string[] = []
    const subscription = subscribeV2Events(
      ctx,
      ({ event }) => {
        delivered.push(event.type)
      },
      { debug: (message) => logs.push(message) },
    )

    // when
    try {
      ctx.__pushEvent({
        type: "session.step.failed",
        created: 5,
        data: { sessionID: "ses_1", assistantMessageID: "msg_1", error: "plain string" },
      })
      await flushAsync()
      ctx.__pushEvent({ type: "session.deleted", created: 6, data: { sessionID: "ses_1" } })
      await flushAsync()
    } finally {
      await subscription.stop()
    }

    // then
    expect(delivered).toEqual(["session.deleted"])
    expect(logs.some((message) => message.includes("session.step.failed"))).toBe(true)
  })

  it("delivers coalesced snapshot refreshes through the same handler", async () => {
    // given
    const ctx = createFakeV2Context()
    const scheduler = createManualEventScheduler()
    await ctx.session.create({ id: "ses_1" })
    const delivered: string[] = []
    const subscription = subscribeV2Events(
      ctx,
      ({ event }) => {
        delivered.push(event.type)
      },
      { scheduler },
    )

    // when: a payload-sufficient event patches immediately, a refresh event
    // schedules the fetch, the manual scheduler controls the batch
    try {
      ctx.__pushEvent({
        type: "session.inbox.enqueued",
        created: 5,
        data: {
          sessionID: "ses_1",
          inboxID: "msg_1",
          item: { type: "user", delivery: "steer", payload: { text: "hi" } },
        },
      })
      await flushAsync()
      ctx.__pushEvent({ type: "session.inbox.delivered", created: 6, data: { sessionID: "ses_1", inboxID: "msg_1" } })
      await flushAsync()
      scheduler.fire()
      await flushAsync()
    } finally {
      await subscription.stop()
    }

    // then
    expect(delivered).toEqual(["message.updated", "message.part.updated"])
  })

  it("stop() aborts the subscription and later pushes deliver nothing", async () => {
    // given
    const ctx = createFakeV2Context()
    const delivered: string[] = []
    const subscription = subscribeV2Events(ctx, ({ event }) => {
      delivered.push(event.type)
    })

    // when
    ctx.__pushEvent({ type: "session.created", created: 5, data: { sessionID: "ses_1" } })
    await flushAsync()
    await subscription.stop()
    ctx.__pushEvent({ type: "session.deleted", created: 6, data: { sessionID: "ses_1" } })
    await flushAsync()
    await subscription.stop()

    // then
    expect(delivered).toEqual(["session.created"])
  })

  describe("event stats line (live rows L-11/L-24)", () => {
    function parseStats(lines: readonly string[]): Record<string, unknown> {
      const stats = lines.filter((line) => line.startsWith("event stats "))
      expect(stats, "exactly one stats line per stop").toHaveLength(1)
      return JSON.parse(stats[0]?.slice("event stats ".length) ?? "{}") as Record<string, unknown>
    }

    function throwingFetchContext(events: readonly { type: string; data: unknown }[]): V2EventSubscriptionContext {
      const stream = async function* () {
        for (const event of events) yield event as V2IncomingEvent
      }
      return {
        session: {
          context: async () => {
            throw new Error("fetch boom")
          },
        },
        event: { subscribe: () => stream() },
        location: { directory: "/tmp/stats-dir" },
      }
    }

    it("#given a replay with fetch-worthy events #when the subscription stops #then the counters land on the pinned keys and satisfy the fetch bound", async () => {
      // given
      const scheduler = createManualEventScheduler()
      const ctx = createFakeV2Context({ scheduler })
      void ctx.session.create({ id: "ses_1" })
      const logs: string[] = []
      const subscription = subscribeV2Events(ctx, () => undefined, {
        scheduler,
        debug: (message) => logs.push(message),
      })

      // when
      try {
        ctx.__pushEvent({ type: "session.created", created: 5, data: { sessionID: "ses_1" } })
        await flushAsync()
        ctx.__pushEvent({ type: "session.step.first-token", created: 6, data: { sessionID: "ses_1" } })
        ctx.__pushEvent({ type: "session.step.first-token", created: 7, data: { sessionID: "ses_1" } })
        await flushAsync()
        scheduler.fire()
        await flushAsync()
      } finally {
        await subscription.stop()
      }
      await subscription.stop()

      // then
      const stats = parseStats(logs) as V2EventStats
      expect(stats.directory).toBe("/tmp/fake-v2")
      expect(stats.eventsSeen).toBe(3)
      expect(stats.translated).toBe(1)
      expect(stats.fetchWorthy).toBe(2)
      expect(stats.coalesceBatches).toBe(1)
      expect(stats.contextFetches).toBe(1)
      expect(stats.contextFetchFailures).toBe(0)
      expect(
        (stats.contextFetches as number) <= (stats.fetchWorthy as number) + (stats.coalesceBatches as number),
        "contextFetches <= fetchWorthy + coalesceBatches",
      ).toBe(true)
      const captured = logs.find((line) => line.startsWith("event stats ")) ?? ""
      expect(formatV2EventStats(stats), "the file-log line carries the full pinned marker").toBe(
        `[opencode-v2] ${captured}`,
      )
    })

    it("#given a context fetch that throws #when the batch runs and the subscription stops #then the failure counter and directory land on the line", async () => {
      // given
      const logs: string[] = []
      const subscription = subscribeV2Events(
        throwingFetchContext([
          { type: "session.step.first-token", data: { sessionID: "ses_9" } },
          { type: "session.step.first-token", data: { sessionID: "ses_9" } },
        ]),
        () => undefined,
        { debug: (message) => logs.push(message) },
      )

      // when
      await flushAsync()
      await flushAsync()
      await subscription.stop()

      // then
      const stats = parseStats(logs)
      expect(stats.directory).toBe("/tmp/stats-dir")
      expect(stats.eventsSeen).toBe(2)
      expect(stats.fetchWorthy).toBe(2)
      expect(stats.coalesceBatches).toBe(1)
      expect(stats.contextFetches).toBe(1)
      expect(stats.contextFetchFailures).toBe(1)
    })
  })
})
