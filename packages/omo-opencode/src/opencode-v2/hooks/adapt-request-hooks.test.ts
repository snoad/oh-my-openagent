import { describe, expect, it } from "bun:test"

import type { SessionMessageInfo } from "@opencode/client"
import { v1NotFound } from "../client/v1-client-surface"
import type { V1ClientShimSurface } from "../client/v1-client-surface"
import { createFakeV2Context, type FakeV2Context } from "../parity/fake-v2-context"
import type { V2Runtime } from "../runtime/stop-v2-runtime"
import { registerRequestHookAdapters, type V2ModelRequestEvent } from "./adapt-request-hooks"

// Contract tests for the chat.headers -> model.request adapter (plan task 18
// of the opencode-v2-compat plan): the engine receives the V1 chat.headers
// input ({ sessionID, provider: { id }, message: { id, role } }), the
// produced headers merge into the mutable event.headers, a message carried
// by the event skips the shim lookup, a missing or failing message lookup
// logs and leaves the headers untouched, and an engine throw propagates as
// the hook veto.

const SESSION = "ses_headers"

type RecordedCall = {
  readonly input: { sessionID: string; provider: { id: string }; message: { id?: string; role?: string } }
  readonly output: { headers: Record<string, string> }
}

function createRuntime(engine: V2Runtime["engine"]): V2Runtime {
  return {
    directory: "/tmp/fake-v2",
    engine,
    tracker: { releasedDeps: new Set(), sharedHandles: [] },
    abort: new AbortController(),
    stopped: false,
    stop: async () => {},
  }
}

function seedUser(ctx: FakeV2Context, sessionID: string, id: string, text = "internal prompt"): void {
  const record = ctx.__sessions.get(sessionID)
  if (record === undefined) throw new Error(`unknown session ${sessionID}`)
  const entry: SessionMessageInfo = { id, type: "user", time: { created: 10 }, text, files: [] }
  ;(record.context as SessionMessageInfo[]).push(entry)
}

function requestEvent(overrides: Partial<V2ModelRequestEvent> = {}): V2ModelRequestEvent {
  return {
    sessionID: SESSION,
    kind: "primary",
    model: { id: "claude-x", providerID: "github-copilot" },
    headers: {},
    ...overrides,
  }
}

function recordingEngine(): { calls: RecordedCall[]; engine: Record<string, unknown> } {
  const calls: RecordedCall[] = []
  const engine = {
    "chat.headers": async (
      input: { sessionID: string; provider: { id: string }; message: { id?: string; role?: string } },
      output: { headers: Record<string, string> },
    ): Promise<void> => {
      calls.push({ input, output })
      if (input.message.role === "user") output.headers["x-initiator"] = "agent"
    },
  }
  return { calls, engine }
}

async function fire(ctx: FakeV2Context, event: V2ModelRequestEvent): Promise<V2ModelRequestEvent> {
  return ctx.__fire("session", "model.request", event)
}

describe("adapt-request-hooks", () => {
  it("#given a session with a seeded user message #when the model.request hook fires #then the engine receives the V1 input and the produced headers merge into event.headers", async () => {
    // given
    const ctx = createFakeV2Context()
    await ctx.session.create({ id: SESSION })
    seedUser(ctx, SESSION, "msg_user")
    const { calls, engine } = recordingEngine()
    registerRequestHookAdapters({ ctx, runtime: createRuntime(engine) })

    // when
    const event = await fire(ctx, requestEvent())

    // then
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toEqual({
      sessionID: SESSION,
      provider: { id: "github-copilot" },
      message: { id: "msg_user", role: "user" },
    })
    expect(event.headers["x-initiator"]).toBe("agent")
  })

  it("#given an event that carries the message #when the hook fires #then the carried message reaches the engine without a session snapshot lookup", async () => {
    // given
    const ctx = createFakeV2Context()
    await ctx.session.create({ id: SESSION })
    const { calls, engine } = recordingEngine()
    registerRequestHookAdapters({ ctx, runtime: createRuntime(engine) })

    // when
    await fire(ctx, requestEvent({ message: { id: "msg_carried", role: "user" } }))

    // then
    expect(calls[0]?.input.message).toEqual({ id: "msg_carried", role: "user" })
    expect(ctx.__calls.some((call) => call.op === "session.context")).toBe(false)
  })

  it("#given a session without a user message #when the hook fires #then the engine sees an empty message and event.headers stays unchanged", async () => {
    // given
    const ctx = createFakeV2Context()
    await ctx.session.create({ id: SESSION })
    const { calls, engine } = recordingEngine()
    registerRequestHookAdapters({ ctx, runtime: createRuntime(engine) })

    // when
    const event = await fire(ctx, requestEvent())

    // then
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input.message).toEqual({})
    expect(Object.keys(event.headers)).toEqual([])
  })

  it("#given a client whose session.message lookup fails #when the hook fires #then the failure is logged and event.headers stays unchanged", async () => {
    // given
    const ctx = createFakeV2Context()
    await ctx.session.create({ id: SESSION })
    seedUser(ctx, SESSION, "msg_user")
    const failingClient = {
      session: {
        messages: async () => {
          throw new Error("snapshot unavailable")
        },
      },
    } as unknown as V1ClientShimSurface
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (message: string) => {
      warnings.push(message)
    }
    const { engine } = recordingEngine()
    try {
      registerRequestHookAdapters({ ctx, runtime: createRuntime(engine), client: failingClient })

      // when
      const event = await fire(ctx, requestEvent())

      // then
      expect(Object.keys(event.headers)).toEqual([])
      expect(warnings.some((message) => message.includes("chat.headers") && message.includes(SESSION))).toBe(true)
    } finally {
      console.warn = originalWarn
    }
  })

  it("#given a client answering a not-found envelope for session.message #when the hook fires #then the lookup failure logs and the request is not rejected", async () => {
    // given
    const ctx = createFakeV2Context()
    await ctx.session.create({ id: SESSION })
    seedUser(ctx, SESSION, "msg_user")
    const failingClient = {
      session: {
        messages: async () => ({
          data: [{ info: { id: "msg_user", role: "user" as const, time: { created: 10 } }, parts: [] }],
          error: undefined,
          request: new Request("http://opencode-v2-shim.internal/messages"),
          response: new Response(null, { status: 200 }),
        }),
        message: async () => v1NotFound("message msg_user not found", "/message"),
      },
    } as unknown as V1ClientShimSurface
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (message: string) => {
      warnings.push(message)
    }
    const { calls, engine } = recordingEngine()
    try {
      registerRequestHookAdapters({ ctx, runtime: createRuntime(engine), client: failingClient })

      // when
      const event = await fire(ctx, requestEvent())

      // then
      expect(calls).toHaveLength(1)
      expect(calls[0]?.input.message).toEqual({})
      expect(Object.keys(event.headers)).toEqual([])
      expect(warnings.some((message) => message.includes("msg_user"))).toBe(true)
    } finally {
      console.warn = originalWarn
    }
  })

  it("#given an engine handler that throws #when the hook fires #then the rejection propagates unchanged and event.headers stays unchanged", async () => {
    // given
    const ctx = createFakeV2Context()
    await ctx.session.create({ id: SESSION })
    seedUser(ctx, SESSION, "msg_user")
    const engine = {
      "chat.headers": async (): Promise<void> => {
        throw new Error("VETO_HEADERS")
      },
    }
    registerRequestHookAdapters({ ctx, runtime: createRuntime(engine) })
    const event = requestEvent()

    // when
    const outcome = fire(ctx, event)

    // then
    expect(outcome).rejects.toThrow("VETO_HEADERS")
    expect(Object.keys(event.headers)).toEqual([])
  })

  it("#given an auxiliary title request #when the hook fires for kind title #then the adapter applies for every request kind", async () => {
    // given
    const ctx = createFakeV2Context()
    await ctx.session.create({ id: SESSION })
    seedUser(ctx, SESSION, "msg_user")
    const { calls, engine } = recordingEngine()
    registerRequestHookAdapters({ ctx, runtime: createRuntime(engine) })

    // when
    const event = await fire(ctx, requestEvent({ kind: "title" }))

    // then
    expect(calls).toHaveLength(1)
    expect(event.headers["x-initiator"]).toBe("agent")
  })
})
