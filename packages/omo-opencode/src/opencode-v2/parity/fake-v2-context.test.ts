import { describe, expect, it } from "bun:test"

import { createFakeV2Context } from "./fake-v2-context"
import type { FakeV2Event } from "./fake-v2-registry"
import type { FakeSessionPromptEvent } from "./fake-v2-session-store"

describe("Fake OpenCode 2 plugin context", () => {
  it("runs registered hooks in registration order and returns the mutated event", async () => {
    // given
    const ctx = createFakeV2Context()
    const seen: string[] = []
    await ctx.shell.hook("create.before", (event: { command: string }) => {
      seen.push(`first:${event.command}`)
      event.command = "rewritten"
    })
    await ctx.shell.hook("create.before", (event: { command: string }) => {
      seen.push(`second:${event.command}`)
    })

    // when
    const result = await ctx.__fire("shell", "create.before", { command: "original" })

    // then
    expect(seen).toEqual(["first:original", "second:rewritten"])
    expect(result.command).toBe("rewritten")
  })

  it("propagates a hook callback rejection to __fire and does not run later hooks", async () => {
    // given
    const ctx = createFakeV2Context()
    let laterRan = false
    await ctx.permission.hook("evaluate", () => {
      throw new Error("hook boom")
    })
    await ctx.permission.hook("evaluate", () => {
      laterRan = true
    })

    // when / then
    await expect(
      ctx.__fire("permission", "evaluate", { sessionID: "ses_1", action: "read", resources: [], effect: "ask" }),
    ).rejects.toThrow("hook boom")
    expect(laterRan).toBe(false)
  })

  it("skips provider-scoped session hooks when the fire options name a different provider", async () => {
    // given
    const ctx = createFakeV2Context()
    const seen: string[] = []
    await ctx.session.hook("model.request", () => {
      seen.push("unscoped")
    })
    await ctx.session.hook(
      "model.request",
      () => {
        seen.push("scoped")
      },
      { providerID: "anthropic" },
    )

    // when
    await ctx.__fire("session", "model.request", { model: { id: "m", providerID: "openai" } }, { providerID: "openai" })

    // then
    expect(seen).toEqual(["unscoped"])
    seen.length = 0
    await ctx.__fire("session", "model.request", { model: { id: "m", providerID: "claude" } }, { providerID: "anthropic" })
    expect(seen).toEqual(["unscoped", "scoped"])
  })

  it("removes a registration on dispose", async () => {
    // given
    const ctx = createFakeV2Context()
    const seen: string[] = []
    const registration = await ctx.shell.hook("create.before", () => {
      seen.push("ran")
    })
    await ctx.__fire("shell", "create.before", { command: "x" })
    expect(seen).toEqual(["ran"])

    // when
    await registration.dispose()
    await ctx.__fire("shell", "create.before", { command: "x" })

    // then
    expect(seen).toEqual(["ran"])
  })

  it("replays captured transforms in registration order onto a fresh value", async () => {
    // given
    const ctx = createFakeV2Context()
    await ctx.agent.transform((editor) => {
      editor.add({ id: "agent-a", name: "A", mode: "primary", hidden: false })
    })
    await ctx.agent.transform((editor) => {
      editor.update("agent-a", (agent) => {
        agent.name = "A2"
      })
    })

    // when
    const replayed = ctx.__replay("agent")
    const replayedAgain = ctx.__replay("agent")

    // then
    expect(replayed.list().map((agent) => [agent.id, agent.name])).toContainEqual(["agent-a", "A2"])
    expect(replayedAgain.list().filter((agent) => agent.id === "agent-a")).toHaveLength(1)
    expect(replayed.get("build")?.mode).toBe("primary")
    const live = await ctx.agent.list()
    expect(live.data.map((agent) => agent.id)).toContain("build")
    expect(live.data.map((agent) => agent.id)).toContain("agent-a")
  })

  it("loads the default agent and tool data from the host-2.4.1 fixtures", async () => {
    // given
    const ctx = createFakeV2Context()

    // when
    const agents = await ctx.agent.list()
    const tools = await ctx.tool.list()

    // then
    expect(agents.data).toHaveLength(8)
    expect(agents.data.map((agent) => agent.id)).toContain("build")
    expect(tools).toHaveLength(13)
    expect(tools.map((tool) => tool.id)).toContain("execute")
    expect(tools.find((tool) => tool.id === "execute")?.parameters?.["type"]).toBe("object")
  })

  it("serves the session store behind create, get, list, context and update", async () => {
    // given
    const ctx = createFakeV2Context()

    // when
    const created = await ctx.session.create({ title: "hermetic", agent: "build" })
    const listed = await ctx.session.list()

    // then
    expect(created.id).toMatch(/^ses_\d+$/)
    expect(created.title).toBe("hermetic")
    expect(created.agent).toBe("build")
    expect(await ctx.session.get({ sessionID: created.id })).toBe(created)
    expect(listed.data.map((session) => session.id)).toEqual([created.id])
    expect(await ctx.session.context({ sessionID: created.id })).toEqual([])

    // when
    await ctx.session.update({ sessionID: created.id, title: "renamed", metadata: { omo: { internal: true } } })

    // then
    expect((await ctx.session.get({ sessionID: created.id })).title).toBe("renamed")
    expect(created.metadata).toEqual({ omo: { internal: true } })
    await expect(ctx.session.get({ sessionID: "ses_missing" })).rejects.toThrow("unknown session ses_missing")
  })

  it("queues the prompt item, records the call and sets the session busy", async () => {
    // given
    const ctx = createFakeV2Context()
    const info = await ctx.session.create({ id: "ses_prompt" })

    // when
    const inbox = await ctx.session.prompt({ sessionID: info.id, text: "do work" })

    // then
    const record = ctx.__sessions.get("ses_prompt")
    expect(record?.prompts).toHaveLength(1)
    expect(record?.busy).toBe(true)
    expect(record?.prompts[0]?.payload.text).toBe("do work")
    expect(inbox.sessionID).toBe("ses_prompt")
    expect(inbox.type).toBe("user")
    expect(inbox.payload.text).toBe("do work")
    expect(info.time.busy).toBeDefined()
    const promptCall = ctx.__calls.find((entry) => entry.op === "session.prompt")
    expect(promptCall?.args[0]).toMatchObject({ sessionID: "ses_prompt", text: "do work" })
  })

  it("clears the busy flag on interrupt", async () => {
    // given
    const ctx = createFakeV2Context()
    const info = await ctx.session.create({})
    await ctx.session.prompt({ sessionID: info.id, text: "long work" })

    // when
    const result = await ctx.session.interrupt({ sessionID: info.id })

    // then
    expect(result.interrupted).toBe(true)
    expect(ctx.__sessions.get(info.id)?.busy).toBe(false)
    expect((await ctx.session.interrupt({ sessionID: info.id })).interrupted).toBe(false)
  })

  it("fires the prompt hook for user prompts but not for omo.internal admissions", async () => {
    // given
    const ctx = createFakeV2Context()
    const info = await ctx.session.create({})
    const fired: FakeSessionPromptEvent[] = []
    await ctx.session.hook("prompt", (event: FakeSessionPromptEvent) => {
      fired.push(event)
    })

    // when
    await ctx.session.prompt({ sessionID: info.id, text: "user prompt" })
    await ctx.session.prompt({ sessionID: info.id, text: "internal continuation", metadata: { omo: { internal: true } } })

    // then
    expect(fired).toHaveLength(1)
    expect(fired[0]?.sessionID).toBe(info.id)
    expect(fired[0]?.prompt.text).toBe("user prompt")
    expect(fired[0]?.delivery).toBe("steer")
    expect(ctx.__sessions.get(info.id)?.prompts).toHaveLength(2)
  })

  it("feeds every active event subscriber and honors type filters", async () => {
    // given
    const ctx = createFakeV2Context()
    const all: FakeV2Event[] = []
    const renamed: FakeV2Event[] = []
    const allIteration = (async () => {
      for await (const event of ctx.event.subscribe()) {
        all.push(event)
        if (all.length === 2) break
      }
    })()
    const renamedIteration = (async () => {
      for await (const event of ctx.event.subscribe({ types: ["session.renamed"] })) {
        renamed.push(event)
        if (renamed.length === 1) break
      }
    })()

    // when
    ctx.__pushEvent({ type: "session.created" })
    ctx.__pushEvent({ type: "session.renamed" })
    await Promise.all([allIteration, renamedIteration])

    // then
    expect(all.map((event) => event.type)).toEqual(["session.created", "session.renamed"])
    expect(renamed.map((event) => event.type)).toEqual(["session.renamed"])
  })

  it("ends event subscriptions through their abort signal", async () => {
    // given
    const ctx = createFakeV2Context()
    const controller = new AbortController()
    const received: FakeV2Event[] = []
    const iteration = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        received.push(event)
      }
    })()

    // when
    ctx.__pushEvent({ type: "session.created" })
    controller.abort()
    await iteration
    ctx.__pushEvent({ type: "session.renamed" })

    // then
    expect(received.map((event) => event.type)).toEqual(["session.created"])
  })

  it("records every domain method call as <domain>.<method> with its arguments", async () => {
    // given
    const ctx = createFakeV2Context()

    // when
    await ctx.shell.hook("create.before", () => {})
    await ctx.session.create({ id: "ses_calls" })
    await ctx.agent.list()
    await ctx.storage.set("omo.key", "value")

    // then
    const ops = ctx.__calls.map((entry) => entry.op)
    expect(ops).toContain("shell.hook")
    expect(ops).toContain("session.create")
    expect(ops).toContain("agent.list")
    expect(ops).toContain("storage.set")
    const createCall = ctx.__calls.find((entry) => entry.op === "session.create")
    expect(createCall?.args[0]).toMatchObject({ id: "ses_calls" })
    expect(ctx.__sessions.has("ses_calls")).toBe(true)
  })

  it("serves storage through the map with scan prefix, after and limit semantics", async () => {
    // given
    const ctx = createFakeV2Context()
    await ctx.storage.set("omo/a", 1)
    await ctx.storage.set("omo/b", 2)
    await ctx.storage.set("omo/c", 3)
    await ctx.storage.set("other/d", 4)

    // when
    const page = await ctx.storage.scan({ prefix: "omo/", limit: 2 })

    // then
    expect(page.entries.map((entry) => entry.key)).toEqual(["omo/a", "omo/b"])
    expect(page.next).toBe("omo/b")
    expect(await ctx.storage.scan({ prefix: "omo/", after: "omo/b" })).toMatchObject({
      entries: [{ key: "omo/c", value: 3 }],
    })
    expect(ctx.__storage.get("omo/a")).toBe(1)
    expect(await ctx.storage.get("other/d")).toBe(4)
    expect(await ctx.storage.get("missing")).toBeUndefined()
  })

  it("denies permission assert when the evaluate hook sets deny", async () => {
    // given
    const ctx = createFakeV2Context()
    await ctx.permission.hook("evaluate", (event: { effect: string }) => {
      event.effect = "deny"
    })

    // when / then
    await expect(ctx.permission.assert({ sessionID: "ses_1", action: "read", resources: ["x"] })).rejects.toThrow(
      "fake v2: permission denied for read",
    )
  })

  it("dispatches rpc calls to registered handlers and emits rpc events", async () => {
    // given
    const ctx = createFakeV2Context()
    const received: FakeV2Event[] = []
    const iteration = (async () => {
      for await (const event of ctx.event.subscribe({ types: ["rpc.omo.state"] })) {
        received.push(event)
        if (received.length === 1) break
      }
    })()
    const registration = await ctx.rpc.register({ id: "omo" }, {
      state: async () => ({ roster: 3 }),
    })

    // when
    const result = await ctx.rpc.call({ rpcID: "omo", method: "state" })
    await registration.events.emit("omo.state", { roster: 3 })
    await iteration
    await registration.dispose()

    // then
    expect(result.output).toEqual({ roster: 3 })
    expect(received[0]?.type).toBe("rpc.omo.state")
    await expect(ctx.rpc.call({ rpcID: "omo", method: "state" })).rejects.toThrow("no rpc handler omo.state")
  })

  it("uses the injected scheduler for time and keeps defaults for app and location", async () => {
    // given
    let now = 1000
    const scheduler = {
      now: () => now,
      setTimeout: (callback: () => void) => {
        callback()
        return () => {}
      },
    }
    const ctx = createFakeV2Context({ scheduler })

    // when
    const info = await ctx.session.create({})
    now = 2000

    // then
    expect(info.time.created).toBe(1000)
    expect(ctx.__scheduler.now()).toBe(2000)
    expect(ctx.app).toEqual({ name: "opencode", version: "2.4.1", channel: "stable" })
    expect(ctx.location.directory).toBe("/tmp/fake-v2")
    expect(ctx.options).toEqual({})
  })
})
