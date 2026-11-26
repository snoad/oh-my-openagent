import { expect } from "./bun-test-shim"

import type { Hooks } from "@opencode-ai/plugin"
import hookContextFixture from "./fixtures/host-2.4.1/hook-context-b.json"
import { createFakeV2Context } from "./fake-v2-context"
import { registerContextHookAdapter } from "../hooks/adapt-context-hook"
import type { V2HookContextEvent } from "../hooks/context-message-codec"
import type { V2Runtime } from "../runtime/stop-v2-runtime"
import { defineGroup, type ParityRow, type ParityRowGroupItem } from "./rows"

// Wave-2 H-HOOK rows (plan task 17): the context hook adapter drives the three
// V1 request transforms over the recorded host payload. The messages row is
// the id-keyed write-back regression: when the V1 output order differs from
// the input order, no part may move between message ids (the upstream
// index-based write-back bug, issues #9389 / PR #9391).

type FixtureContextPayload = {
  sessionID: string
  agent: string
  model: { id: string; providerID: string }
  system: Array<Record<string, unknown>>
  messages: Array<{ id?: string; role?: string; content: Array<Record<string, unknown>> }>
  options: Record<string, unknown>
}

const fixturePayloads: FixtureContextPayload[] = (hookContextFixture as { context: FixtureContextPayload[] }).context

function row(suffix: string, title: string, check: () => void | Promise<void>): ParityRowGroupItem {
  return { suffix, title, kind: "hermetic", is: ["IS-4"], wave: 2, status: "checked", check }
}

async function fire(engine: Hooks, mutate?: (event: V2HookContextEvent) => void): Promise<V2HookContextEvent> {
  const ctx = createFakeV2Context()
  const runtime: V2Runtime = {
    directory: "/tmp/w2-context",
    engine,
    tracker: { releasedDeps: new Set(), sharedHandles: [] },
    abort: new AbortController(),
    stop: () => Promise.resolve(),
    stopped: false,
  }
  registerContextHookAdapter({ ctx, runtime })
  const event = structuredClone(fixturePayloads[1]) as V2HookContextEvent
  mutate?.(event)
  await ctx.__fire("session", "context", event)
  return event
}

function partKind(part: Record<string, unknown>): string {
  if (part["type"] === "tool-call" || part["type"] === "tool-result")
    return `${String(part["type"])}:${String(part["id"])}`
  if (part["type"] === "reasoning") return `reasoning:${String(part["text"])}`
  return `text:${String(part["text"])}`
}

function partsByKey(event: V2HookContextEvent): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const message of event.messages) {
    const key =
      typeof message.id === "string"
        ? message.id
        : `tool:${message.content
            .filter((part) => part["type"] === "tool-result")
            .map((part) => String(part["id"]))
            .join(",")}`
    map.set(key, message.content.map(partKind))
  }
  return map
}

function checkSystemTransform(): Promise<void> {
  const nonText = { type: "custom", kind: "image", url: "file:///tmp/cover.png" }
  const engine: Hooks = {
    "experimental.chat.system.transform": async (_input, output) => {
      output.system = ["intro-v2", "outro-v2", "appended-guidance"]
    },
  }
  return fire(engine, (event) => {
    event.system = [{ type: "text", text: "intro" }, nonText, { type: "text", text: "outro" }]
  }).then((event) => {
    expect(event.system).toEqual([
      { type: "text", text: "intro-v2" },
      nonText,
      { type: "text", text: "outro-v2" },
      { type: "text", text: "appended-guidance" },
    ])
  })
}

function checkMessagesTransform(): Promise<void> {
  const engine: Hooks = {
    "experimental.chat.messages.transform": async (_input, output) => {
      output.messages = [...output.messages].reverse()
    },
  }
  return fire(engine, (event) => {
    const assistant = event.messages.find((message) => message.id === "msg_211437761001Vj9DUJn7sq6dsE")
    if (assistant === undefined) throw new Error("fixture assistant message missing")
    assistant.content = [{ type: "reasoning", text: "step 1" }, ...assistant.content]
  }).then((event) => {
    const after = partsByKey(event)
    expect(after.size, "message count unchanged").toBe(3)
    expect(after.get("msg_21143774c001uPi36BYiKp6jeh")).toEqual([
      "text:Read capture-b.txt and reply with its exact content",
    ])
    expect(after.get("msg_211437761001Vj9DUJn7sq6dsE")).toEqual(["reasoning:step 1", "tool-call:call_1"])
    expect(after.get("tool:call_1")).toEqual(["tool-result:call_1"])
  })
}

function checkChatParamsApplied(): Promise<void> {
  const engine: Hooks = {
    "chat.params": async (input, output) => {
      expect(input.sessionID, "sessionID reaches the V1 handler").toBe("ses_deebc88bdffekHqnkcxwM2osoW")
      output.temperature = 0.4
      output.topK = 40
      output.maxOutputTokens = 2048
      output.options.reasoningEffort = "high"
    },
  }
  return fire(engine).then((event) => {
    expect(event.options).toEqual({ temperature: 0.4, topK: 40, maxTokens: 2048, reasoningEffort: "high" })
  })
}

function checkChatParamsNoop(): Promise<void> {
  const engine: Hooks = {
    "chat.params": async () => {},
  }
  return fire(engine, (event) => {
    event.options = { temperature: 0.7 }
  }).then((event) => {
    expect(event.options, "a no-op params handler leaves host options untouched").toEqual({ temperature: 0.7 })
  })
}

export const hHookContextRows: ParityRow[] = defineGroup("H-HOOK", [
  row(
    "SYSTEM-TRANSFORM",
    "the system transform replaces text parts in order, appends new entries and keeps non-text parts",
    checkSystemTransform,
  ),
  row(
    "MESSAGES-TRANSFORM",
    "a reordered V1 messages-transform output writes back strictly by message id and toolCallId",
    checkMessagesTransform,
  ),
  row(
    "CHAT-PARAMS",
    "chat.params tuning and provider options land in event.options while a no-op handler changes nothing",
    () => checkChatParamsApplied().then(checkChatParamsNoop),
  ),
])
