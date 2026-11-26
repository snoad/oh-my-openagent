import { describe, expect, it } from "bun:test"

import type { SessionMessageInfo } from "@opencode/client"
import { createFakeV2Context, type FakeV2Context } from "../parity/fake-v2-context"
import { createV2ClientShim } from "./v2-client-shim"

// Contract tests for the OpenCode 2 backed V1 client shim session domain: one
// case per shim method, asserting the routed ctx call (through the fake ctx
// __calls log or a local stub recorder for the methods the fake does not
// implement) and the returned V1 response shape. The misc-domain contracts
// live in v2-client-shim-misc.test.ts.

const SESSION_TITLE = "shim contract"

function setup() {
  const ctx = createFakeV2Context()
  const shim = createV2ClientShim(ctx, { promptWaitPollMs: 1 })
  return { ctx, shim }
}

async function createSession(shim: ReturnType<typeof createV2ClientShim>): Promise<string> {
  const created = await shim.session.create({ body: { title: SESSION_TITLE } })
  if (created.data.id === undefined) throw new Error("session create returned no id")
  return created.data.id
}

function seedAssistant(ctx: FakeV2Context, sessionID: string, text = "assistant reply"): void {
  const record = ctx.__sessions.get(sessionID)
  if (record === undefined) throw new Error(`unknown session ${sessionID}`)
  const entry: SessionMessageInfo = {
    id: "msg_assistant_seed",
    type: "assistant",
    agent: "build",
    model: { id: "claude-x", providerID: "anthropic" },
    content: [{ type: "text", text }],
    time: { created: 10, completed: 11 },
  }
  ;(record.context as SessionMessageInfo[]).push(entry)
}

function callOps(ctx: FakeV2Context, op: string): number {
  return ctx.__calls.filter((call) => call.op === op).length
}

describe("v2 client shim session methods", () => {
  it("#given an idle session #when session.promptAsync is called #then the admission is routed with the omo.internal tag and the V1 async envelope is returned", async () => {
    // given
    const { ctx, shim } = setup()
    const sessionID = await createSession(shim)

    // when
    const result = await shim.session.promptAsync({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text: "continue the work" }] },
    })

    // then
    const admission = ctx.__calls.find((call) => call.op === "session.prompt")
    expect(admission?.args[0]).toMatchObject({
      sessionID,
      text: "continue the work",
      metadata: { omo: { internal: true } },
    })
    expect(result.data).toBeUndefined()
    expect(result.error).toBeUndefined()
    expect(result.request).toBeInstanceOf(Request)
    expect(result.response).toBeInstanceOf(Response)
  })

  it("#given a session with a finished assistant turn #when session.prompt is called and aborted #then the admission is routed, interrupt is called and the V1 assistant pair is returned", async () => {
    // given
    const { ctx, shim } = setup()
    const sessionID = await createSession(shim)
    seedAssistant(ctx, sessionID)

    // when
    const pending = shim.session.prompt({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text: "sync prompt" }] },
    })
    await shim.session.abort({ path: { id: sessionID } })
    const result = await pending

    // then
    expect(callOps(ctx, "session.prompt")).toBe(1)
    expect(callOps(ctx, "session.interrupt")).toBe(1)
    expect(result.data?.info.role).toBe("assistant")
    expect(result.data?.info.id).toBe("msg_assistant_seed")
    expect(result.data?.parts[0]?.type).toBe("text")
  })

  it("#given a fresh message cache #when session.messages is read twice #then the context is fetched once and the V1 pairs are returned", async () => {
    // given
    const { ctx, shim } = setup()
    const sessionID = await createSession(shim)
    seedAssistant(ctx, sessionID, "cached turn")

    // when
    const first = await shim.session.messages({ path: { id: sessionID } })
    const second = await shim.session.messages({ path: { id: sessionID } })

    // then
    expect(callOps(ctx, "session.context")).toBe(1)
    expect(first.data).toHaveLength(1)
    expect(first.data[0]?.info.id).toBe("msg_assistant_seed")
    expect(second.data).toEqual(first.data)
  })

  it("#given a cache invalidated by an admission #when session.messages is read again #then the context is refetched", async () => {
    // given
    const { ctx, shim } = setup()
    const sessionID = await createSession(shim)

    // when
    await shim.session.messages({ path: { id: sessionID } })
    await shim.session.promptAsync({ path: { id: sessionID }, body: { parts: [{ type: "text", text: "go" }] } })
    await shim.session.messages({ path: { id: sessionID } })

    // then
    expect(callOps(ctx, "session.context")).toBe(2)
  })

  it("#given a session with two messages #when session.messages is read with a limit #then only the newest messages are returned", async () => {
    // given
    const { ctx, shim } = setup()
    const sessionID = await createSession(shim)
    const record = ctx.__sessions.get(sessionID)
    if (record === undefined) throw new Error(`unknown session ${sessionID}`)
    ;(record.context as SessionMessageInfo[]).push(
      { id: "msg_user", type: "user", time: { created: 1 }, text: "question", files: [] },
      {
        id: "msg_reply",
        type: "assistant",
        agent: "build",
        model: { id: "m", providerID: "p" },
        content: [{ type: "text", text: "answer" }],
        time: { created: 2, completed: 3 },
      },
    )

    // when
    const result = await shim.session.messages({ path: { id: sessionID }, query: { limit: 1 } })

    // then
    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.info.id).toBe("msg_reply")
  })

  it("#given sessions in the store #when session.status is called without arguments #then a session-id keyed V1 status map is returned", async () => {
    // given
    const { ctx, shim } = setup()
    const sessionID = await createSession(shim)

    // when
    const idle = await shim.session.status()
    await ctx.session.prompt({ sessionID, text: "busy work" })
    const busy = await shim.session.status()

    // then
    expect(callOps(ctx, "session.list")).toBe(2)
    expect(idle.data[sessionID]).toEqual({ type: "idle" })
    expect(busy.data[sessionID]).toEqual({ type: "busy" })
  })

  it("#given a seeded assistant turn #when session.message is called #then the matching V1 pair is returned", async () => {
    // given
    const { ctx, shim } = setup()
    const sessionID = await createSession(shim)
    seedAssistant(ctx, sessionID, "one turn")

    // when
    const result = await shim.session.message({ path: { id: sessionID, messageID: "msg_assistant_seed" } })

    // then
    expect(result.data?.info.id).toBe("msg_assistant_seed")
    expect(result.data?.info.role).toBe("assistant")
    const missing = await shim.session.message({ path: { id: sessionID, messageID: "msg_missing" } })
    expect(missing.data).toBeUndefined()
  })

  it("#given a busy session #when session.abort is called #then interrupt is routed and the interrupted flag is returned", async () => {
    // given
    const { ctx, shim } = setup()
    const sessionID = await createSession(shim)
    await ctx.session.prompt({ sessionID, text: "busy work" })

    // when
    const result = await shim.session.abort({ path: { id: sessionID } })

    // then
    expect(callOps(ctx, "session.interrupt")).toBe(1)
    expect(result.data).toBe(true)
    const idleResult = await shim.session.abort({ path: { id: sessionID } })
    expect(idleResult.data).toBe(false)
  })
})

describe("v2 client shim session lifecycle methods", () => {
  it("#given a ctx without compact #when session.summarize is called #then the graceful path returns false", async () => {
    // given
    const { ctx, shim } = setup()
    const sessionID = await createSession(shim)

    // when
    const result = await shim.session.summarize({
      path: { id: sessionID },
      body: { providerID: "anthropic", modelID: "claude-x" },
    })

    // then
    expect(result.data).toBe(false)
    expect(callOps(ctx, "session.prompt")).toBe(0)
  })

  it("#given a ctx with compact #when session.summarize is called #then ctx.session.compact is routed with the session id and true is returned", async () => {
    // given
    const ctx = createFakeV2Context()
    const compactCalls: Array<{ sessionID: string }> = []
    const shim = createV2ClientShim({
      ...ctx,
      session: {
        ...ctx.session,
        compact: async (input: { sessionID: string }) => {
          compactCalls.push({ sessionID: input.sessionID })
          return {
            id: "inb_compact",
            sessionID: input.sessionID,
            time: { created: 1 },
            type: "compaction",
            payload: {},
            delivery: "steer",
          }
        },
      },
    })
    const created = await shim.session.create({})
    const sessionID = created.data.id

    // when
    const result = await shim.session.summarize({ path: { id: sessionID } })

    // then
    expect(compactCalls).toEqual([{ sessionID }])
    expect(result.data).toBe(true)
  })

  it("#given a parent body #when session.create is called #then ctx.session.create is routed with the mapped fields and the V1 session shape is returned", async () => {
    // given
    const { ctx, shim } = setup()

    // when
    const result = await shim.session.create({
      body: { parentID: "ses_parent", title: SESSION_TITLE },
      query: { directory: "/tmp/fake-v2" },
    })

    // then
    const createCall = ctx.__calls.find((call) => call.op === "session.create")
    expect(createCall?.args[0]).toMatchObject({ parentID: "ses_parent", title: SESSION_TITLE })
    expect(result.data.directory).toBe("/tmp/fake-v2")
    expect(result.data.title).toBe(SESSION_TITLE)
    expect(typeof result.data.id).toBe("string")
    expect(typeof result.data.time.created).toBe("number")
  })

  it("#given two sessions #when session.list is called #then every V1 session is returned", async () => {
    // given
    const { ctx, shim } = setup()
    await createSession(shim)
    await createSession(shim)

    // when
    const result = await shim.session.list()

    // then
    expect(callOps(ctx, "session.list")).toBeGreaterThanOrEqual(1)
    expect(result.data).toHaveLength(2)
    expect(result.data.every((session) => typeof session.id === "string")).toBe(true)
  })

  it("#given an existing session #when session.get is called #then the V1 session is returned", async () => {
    // given
    const { ctx, shim } = setup()
    const sessionID = await createSession(shim)

    // when
    const result = await shim.session.get({ path: { id: sessionID } })

    // then
    expect(callOps(ctx, "session.get")).toBe(1)
    expect(result.data.id).toBe(sessionID)
    expect(result.data.title).toBe(SESSION_TITLE)
  })

  it("#given a ctx without remove #when session.delete is called #then the graceful path resolves", async () => {
    // given
    const { shim } = setup()
    const sessionID = await createSession(shim)

    // when / then
    const result = await shim.session.delete({ path: { id: sessionID } })
    expect(result.data).toBe(false)
    expect(result.error).toBeUndefined()
  })

  it("#given a ctx with remove #when session.delete is called #then ctx.session.remove is routed with the session id", async () => {
    // given
    const ctx = createFakeV2Context()
    const removeCalls: Array<{ sessionID: string }> = []
    const shim = createV2ClientShim({
      ...ctx,
      session: {
        ...ctx.session,
        remove: async (input: { sessionID: string }) => {
          removeCalls.push({ sessionID: input.sessionID })
        },
      },
    })
    const created = await shim.session.create({})
    const sessionID = created.data.id

    // when
    await shim.session.delete({ path: { id: sessionID } })

    // then
    expect(removeCalls).toEqual([{ sessionID }])
  })

  it("#given a parent with one child #when session.children is called #then ctx.session.list is filtered to the child", async () => {
    // given
    const { shim } = setup()
    const parentID = await createSession(shim)
    const child = await shim.session.create({ body: { parentID, title: "child" } })
    await shim.session.create({ body: { title: "unrelated" } })

    // when
    const result = await shim.session.children({ path: { id: parentID } })

    // then
    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.id).toBe(child.data.id)
    expect(result.data[0]?.parentID).toBe(parentID)
  })

  it("#given any session #when session.todo is called #then the empty V1 todo list is returned", async () => {
    // given
    const { shim } = setup()
    const sessionID = await createSession(shim)

    // when
    const result = await shim.session.todo({ path: { id: sessionID } })

    // then
    expect(result.data).toEqual([])
  })
})
