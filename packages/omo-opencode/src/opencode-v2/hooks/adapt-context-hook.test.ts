import { describe, expect, it } from "bun:test"

import type { Hooks } from "@opencode-ai/plugin"
import hookContextFixture from "../parity/fixtures/host-2.4.1/hook-context-b.json"
import { captureConsoleLines } from "../parity/fake-v2-engine"
import { createFakeV2Context } from "../parity/fake-v2-context"
import { resetV2HookMarkersForTesting } from "../runtime/hook-markers"
import type { V2Runtime } from "../runtime/stop-v2-runtime"
import { registerContextHookAdapter } from "./adapt-context-hook"
import type { V2HookContextEvent } from "./context-message-codec"

// Context hook adapter (plan task 17): the OpenCode 2 `context` payload keys
// messages by id (user/assistant) and by toolCallId (the idless tool message),
// so the V1 messages-transform write-back must never rely on array positions.
// The reorder regression guards the upstream bug class where an index-based
// write-back moved an assistant's reasoning and tool-call parts into a tool
// message (issues #9389 / PR #9391).

type FixturePart = Record<string, unknown>
type FixtureMessage = { id?: string; role?: string; content: FixturePart[] }
type FixtureContextPayload = {
  sessionID: string
  agent: string
  model: { id: string; providerID: string }
  system: FixturePart[]
  messages: FixtureMessage[]
  options: FixturePart
  tools: Record<string, unknown>
}

// A single cast here: bun's type stripper miscompiles a chained
// `(x as A) as readonly T[]` assertion (probe: the expression evaluates to
// undefined), so the readonly view comes from the annotated const instead.
const fixturePayloads: FixtureContextPayload[] = (hookContextFixture as { context: FixtureContextPayload[] }).context
const FIXTURE_PAYLOAD_INDEX = 1

function fixtureEvent(): V2HookContextEvent {
  const payload = fixturePayloads[FIXTURE_PAYLOAD_INDEX]
  if (payload === undefined) throw new Error("fixture payload 1 missing from hook-context-b.json")
  return structuredClone(payload) as V2HookContextEvent
}

function makeRuntime(engine: Hooks): V2Runtime {
  return {
    directory: "/tmp/task-17",
    engine,
    tracker: { releasedDeps: new Set(), sharedHandles: [] },
    abort: new AbortController(),
    stop: () => Promise.resolve(),
    stopped: false,
  }
}

async function fireContextHook(event: V2HookContextEvent, engine: Hooks): Promise<void> {
  const ctx = createFakeV2Context()
  registerContextHookAdapter({ ctx, runtime: makeRuntime(engine) })
  await ctx.__fire("session", "context", event)
}

// Snapshot keyed by message id; the idless tool message keys by its
// toolCallId so the comparison itself follows the fixture keying contract.
function partsByMessageKey(event: V2HookContextEvent): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const message of event.messages) {
    const key = messageKeyOf(message)
    map.set(
      key,
      message.content.map((part) => partKindOf(part)),
    )
  }
  return map
}

function messageKeyOf(message: FixtureMessage): string {
  if (typeof message.id === "string") return message.id
  const callIds = message.content.filter((part) => part["type"] === "tool-result").map((part) => String(part["id"]))
  return `tool:${callIds.join(",")}`
}

function partKindOf(part: FixturePart): string {
  if (part["type"] === "tool-call") return `tool-call:${String(part["id"])}`
  if (part["type"] === "tool-result") return `tool-result:${String(part["id"])}`
  if (part["type"] === "reasoning") return `reasoning:${String(part["text"])}`
  if (part["type"] === "text") return `text:${String(part["text"])}`
  return String(part["type"])
}

function mapEqual(before: Map<string, string[]>, after: Map<string, string[]>): boolean {
  if (before.size !== after.size) return false
  for (const [key, parts] of before) {
    const other = after.get(key)
    if (other === undefined || other.join("|") !== parts.join("|")) return false
  }
  return true
}

const FIXTURE_USER_TEXT = "Read capture-b.txt and reply with its exact content"

describe("registerContextHookAdapter", () => {
  it("round-trips the recorded fixture payload through a passthrough engine unchanged", async () => {
    // given
    const event = fixtureEvent()
    const calls: string[] = []
    const engine: Hooks = {
      "experimental.chat.system.transform": async () => {
        calls.push("system")
      },
      "experimental.chat.messages.transform": async () => {
        calls.push("messages")
      },
      "chat.params": async () => {
        calls.push("params")
      },
    }

    // when
    await fireContextHook(event, engine)

    // then
    expect(calls).toEqual(["system", "messages", "params"])
    expect(event.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    expect(event.messages[0]?.content[0]).toEqual({ type: "text", text: FIXTURE_USER_TEXT })
    expect(event.messages[1]?.content[0]?.["id"]).toBe("call_1")
    expect(event.messages[2]?.content[0]?.["id"]).toBe("call_1")
    expect(mapEqual(partsByMessageKey(fixtureEvent()), partsByMessageKey(event))).toBe(true)
  })

  it("keeps every part on its own message when the engine reorders the V1 output", async () => {
    // given
    const event = fixtureEvent()
    const assistant = event.messages[1]
    if (assistant === undefined) throw new Error("fixture assistant message missing")
    assistant.content = [{ type: "reasoning", text: "step 1" }, ...assistant.content]
    const before = partsByMessageKey(event)
    let reordered: { info: { id: string }; parts: unknown[] }[] = []
    const engine: Hooks = {
      "experimental.chat.messages.transform": async (_input, output) => {
        reordered = [...output.messages].reverse()
        output.messages = reordered
      },
    }

    // when
    await fireContextHook(event, engine)

    // then
    const after = partsByMessageKey(event)
    expect(before.get("msg_211437761001Vj9DUJn7sq6dsE")).toEqual(["reasoning:step 1", "tool-call:call_1"])
    expect(before.get("tool:call_1")).toEqual(["tool-result:call_1"])
    expect(mapEqual(before, after)).toBe(true)
    expect(event.messages.map((message) => messageKeyOf(message))).toEqual([
      "msg_21143774c001uPi36BYiKp6jeh",
      "msg_211437761001Vj9DUJn7sq6dsE",
      "tool:call_1",
    ])
    expect(reordered.map((message) => message.info.id)).toEqual([
      "msg_211437761001Vj9DUJn7sq6dsE",
      "msg_21143774c001uPi36BYiKp6jeh",
    ])
    expect(after.get("msg_211437761001Vj9DUJn7sq6dsE")).toEqual(["reasoning:step 1", "tool-call:call_1"])
    expect(after.get("tool:call_1")).toEqual(["tool-result:call_1"])
    expect(after.get("msg_21143774c001uPi36BYiKp6jeh")).toEqual([`text:${FIXTURE_USER_TEXT}`])
  })

  it("lands a V1 filter and appends a synthetic user turn exactly once at the end", async () => {
    // given
    const event = fixtureEvent()
    const engine: Hooks = {
      "experimental.chat.messages.transform": async (_input, output) => {
        const assistant = output.messages.find((message) => message.info.role === "assistant")
        if (assistant === undefined) throw new Error("assistant pair missing in V1 output")
        output.messages = [
          assistant,
          {
            info: {
              id: "msg_synthetic",
              sessionID: event.sessionID,
              role: "user",
              time: { created: 1 },
              agent: event.agent,
              model: { providerID: event.model.providerID, modelID: event.model.id },
            },
            parts: [
              {
                id: "msg_synthetic:0",
                sessionID: event.sessionID,
                messageID: "msg_synthetic",
                type: "text",
                text: "[internal] Continue from the previous assistant state.",
                synthetic: true,
              },
            ],
          },
        ]
      },
    }

    // when
    await fireContextHook(event, engine)

    // then
    expect(event.messages.map((message) => messageKeyOf(message))).toEqual([
      "msg_211437761001Vj9DUJn7sq6dsE",
      "tool:call_1",
      "msg_synthetic",
    ])
    expect(event.messages[2]?.content).toEqual([
      { type: "text", text: "[internal] Continue from the previous assistant state." },
    ])
  })

  it("removes the idless tool message when its owning assistant was filtered", async () => {
    // given
    const event = fixtureEvent()
    const engine: Hooks = {
      "experimental.chat.messages.transform": async (_input, output) => {
        const user = output.messages.find((message) => message.info.role === "user")
        if (user === undefined) throw new Error("user pair missing in V1 output")
        output.messages = [user]
      },
    }

    // when
    await fireContextHook(event, engine)

    // then
    expect(event.messages.map((message) => messageKeyOf(message))).toEqual(["msg_21143774c001uPi36BYiKp6jeh"])
  })

  it("replaces system text parts in order, appends new entries as text parts and keeps non-text parts", async () => {
    // given
    const event = fixtureEvent()
    const nonText = { type: "custom", kind: "image", url: "file:///tmp/cover.png" }
    event.system = [{ type: "text", text: "intro" }, nonText, { type: "text", text: "outro" }]
    const engine: Hooks = {
      "experimental.chat.system.transform": async (_input, output) => {
        output.system = ["intro-v2", "outro-v2", "appended-guidance"]
      },
    }

    // when
    await fireContextHook(event, engine)

    // then
    expect(event.system).toEqual([
      { type: "text", text: "intro-v2" },
      nonText,
      { type: "text", text: "outro-v2" },
      { type: "text", text: "appended-guidance" },
    ])
  })

  it("applies every chat.params entry into event.options", async () => {
    // given
    const event = fixtureEvent()
    event.options = {}
    let seenModel: { id: string; providerID: string } | undefined
    let seenSessionID: string | undefined
    const engine: Hooks = {
      "chat.params": async (input, output) => {
        seenSessionID = input.sessionID
        seenModel = { id: input.model.id, providerID: input.model.providerID }
        output.temperature = 0.4
        output.topP = 0.9
        output.topK = 40
        output.maxOutputTokens = 2048
        output.options.reasoningEffort = "high"
      },
    }

    // when
    await fireContextHook(event, engine)

    // then
    expect(seenSessionID).toBe(event.sessionID)
    expect(seenModel).toEqual({ id: "gpt-fake", providerID: "openai" })
    expect(event.options).toEqual({
      temperature: 0.4,
      topP: 0.9,
      topK: 40,
      maxTokens: 2048,
      reasoningEffort: "high",
    })
  })

  it("leaves host options untouched when the params handler changes nothing", async () => {
    // given
    const event = fixtureEvent()
    event.options = { temperature: 0.7 }
    const engine: Hooks = {
      "chat.params": async () => {},
    }

    // when
    await fireContextHook(event, engine)

    // then
    expect(event.options).toEqual({ temperature: 0.7 })
  })

  it("marks the context hook and all three V1 handlers once per session", async () => {
    // given
    resetV2HookMarkersForTesting()
    const event = fixtureEvent()
    const captured = captureConsoleLines()
    const engine: Hooks = {
      "experimental.chat.system.transform": async () => {},
      "experimental.chat.messages.transform": async () => {},
      "chat.params": async () => {},
    }
    try {
      // when
      await fireContextHook(event, engine)

      // then
      expect(captured.lines).toEqual([
        "[opencode-v2] hook context fired",
        "[opencode-v2] hook experimental.chat.system.transform fired",
        "[opencode-v2] hook experimental.chat.messages.transform fired",
        "[opencode-v2] hook chat.params fired",
      ])
    } finally {
      captured.restore()
    }
  })
})
