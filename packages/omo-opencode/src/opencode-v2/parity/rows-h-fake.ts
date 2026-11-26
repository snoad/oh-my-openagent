import { expect } from "./bun-test-shim"

import { createFakeV2Context } from "./fake-v2-context"
import type { FakeV2Event } from "./fake-v2-registry"
import { defineGroup, type ParityRow } from "./rows"

// Wave-1 fake ctx contract rows, flipped by task 9 together with their
// substrate (fake-v2-context.ts and its split modules). Each check drives the
// fake ctx the way a later hermetic V2 test would.

async function checkHookRegistry(): Promise<void> {
  const ctx = createFakeV2Context()
  const seen: string[] = []
  await ctx.shell.hook("create.before", (event: { command: string }) => {
    seen.push(`one:${event.command}`)
    event.command = "mutated"
  })
  await ctx.shell.hook("create.before", (event: { command: string }) => {
    seen.push(`two:${event.command}`)
  })
  const fired = await ctx.__fire("shell", "create.before", { command: "start" })
  expect(seen).toEqual(["one:start", "two:mutated"])
  expect(fired.command).toBe("mutated")

  const boom = createFakeV2Context()
  let laterRan = false
  await boom.permission.hook("evaluate", () => {
    throw new Error("registry boom")
  })
  await boom.permission.hook("evaluate", () => {
    laterRan = true
  })
  await expect(
    boom.__fire("permission", "evaluate", { sessionID: "ses_row", action: "read", resources: [], effect: "ask" }),
  ).rejects.toThrow("registry boom")
  expect(laterRan).toBe(false)
}

async function checkTransformReplay(): Promise<void> {
  const ctx = createFakeV2Context()
  await ctx.agent.transform((editor) => {
    editor.add({ id: "agent-x", name: "X", mode: "primary", hidden: false })
  })
  await ctx.agent.transform((editor) => {
    editor.update("agent-x", (agent) => {
      agent.name = "X2"
    })
  })
  const replayed = ctx.__replay("agent")
  expect(replayed.list().map((agent) => [agent.id, agent.name])).toContainEqual(["agent-x", "X2"])
  expect((await ctx.agent.list()).data.map((agent) => agent.id)).toContain("agent-x")
}

async function checkSessionStore(): Promise<void> {
  const ctx = createFakeV2Context()
  const info = await ctx.session.create({ id: "ses_row" })
  await ctx.session.prompt({ sessionID: "ses_row", text: "row prompt" })
  expect(ctx.__sessions.get("ses_row")?.info).toBe(info)
  expect(ctx.__sessions.get("ses_row")?.prompts).toHaveLength(1)
  expect(ctx.__sessions.get("ses_row")?.busy).toBe(true)
  expect((await ctx.session.list()).data.map((session) => session.id)).toEqual(["ses_row"])
  expect(await ctx.session.context({ sessionID: "ses_row" })).toEqual([])
}

async function checkEventStream(): Promise<void> {
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
  ctx.__pushEvent({ type: "session.created" })
  ctx.__pushEvent({ type: "session.renamed" })
  await Promise.all([allIteration, renamedIteration])
  expect(all.map((event) => event.type)).toEqual(["session.created", "session.renamed"])
  expect(renamed.map((event) => event.type)).toEqual(["session.renamed"])
}

async function checkAbort(): Promise<void> {
  const ctx = createFakeV2Context()
  const controller = new AbortController()
  const received: FakeV2Event[] = []
  const iteration = (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      received.push(event)
    }
  })()
  ctx.__pushEvent({ type: "session.created" })
  controller.abort()
  await iteration
  ctx.__pushEvent({ type: "session.renamed" })
  expect(received.map((event) => event.type)).toEqual(["session.created"])
}

async function checkPromptHookTag(): Promise<void> {
  const ctx = createFakeV2Context()
  const info = await ctx.session.create({})
  const fired: unknown[] = []
  await ctx.session.hook("prompt", (event) => {
    fired.push(event)
  })
  await ctx.session.prompt({ sessionID: info.id, text: "user prompt" })
  await ctx.session.prompt({ sessionID: info.id, text: "internal continuation", metadata: { omo: { internal: true } } })
  expect(fired).toHaveLength(1)
  expect(ctx.__sessions.get(info.id)?.prompts).toHaveLength(2)
}

export const hFakeRows: ParityRow[] = defineGroup("H-FAKE", [
  {
    suffix: "HOOK-REGISTRY",
    title: "the fake ctx runs registered hooks in registration order and propagates rejections",
    kind: "hermetic",
    is: ["IS-13"],
    wave: 1,
    status: "checked",
    check: checkHookRegistry,
  },
  {
    suffix: "TRANSFORM-REPLAY",
    title: "the fake ctx replays captured transforms in registration order onto a fresh value",
    kind: "hermetic",
    is: ["IS-13"],
    wave: 1,
    status: "checked",
    check: checkTransformReplay,
  },
  {
    suffix: "SESSION-STORE",
    title: "the fake ctx backs the session methods with an in-memory store",
    kind: "hermetic",
    is: ["IS-13"],
    wave: 1,
    status: "checked",
    check: checkSessionStore,
  },
  {
    suffix: "EVENT-STREAM",
    title: "the fake ctx feeds every active event subscriber and honors type filters",
    kind: "hermetic",
    is: ["IS-13"],
    wave: 1,
    status: "checked",
    check: checkEventStream,
  },
  {
    suffix: "ABORT",
    title: "the fake ctx aborts event subscriptions through their signal",
    kind: "hermetic",
    is: ["IS-13"],
    wave: 1,
    status: "checked",
    check: checkAbort,
  },
  {
    suffix: "PROMPT-HOOK-TAG",
    title: "the fake session.prompt fires the prompt hook unless the admission carries the omo.internal tag",
    kind: "hermetic",
    is: ["IS-13"],
    wave: 1,
    status: "checked",
    check: checkPromptHookTag,
  },
])
