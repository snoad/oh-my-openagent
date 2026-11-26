import { expect } from "./bun-test-shim"

import type { SessionMessageInfo } from "@opencode/client"
import contextAFixture from "./fixtures/host-2.4.1/context-a.json"
import {
  fromV1Message,
  fromV1ToolOutput,
  toV1Messages,
  toV1SessionStatus,
  toV1ToolResult,
  toV2PromptInput,
} from "../client/shape-codecs"
import { defineGroup, type ParityRow } from "./rows"

// Wave-1 shape codec rows. Each check drives the real codec family against the
// recorded host-2.4.1 fixtures, asserting id preservation and the exact V1
// shape (no keys outside the V1 surface).

type FixtureEnvelope = { readonly data: readonly unknown[] }

const contextA = (contextAFixture as FixtureEnvelope).data as SessionMessageInfo[]

const SESSION_ID = "ses_deebc88bdffekHqnkcxwM2osoW"

function checkMessagesCodec(): void {
  const host = contextA.filter((entry) => entry.type === "user" || entry.type === "assistant")
  const messages = toV1Messages({ sessionID: SESSION_ID, data: contextA })
  expect(messages.length).toBe(host.length)
  for (const [index, message] of messages.entries()) {
    expect(message.info.id, `H-CODEC-MESSAGES entry ${index} id`).toBe(host[index]?.id)
    for (const part of message.parts) {
      expect(part.messageID).toBe(host[index]?.id)
      expect(part.sessionID).toBe(SESSION_ID)
    }
  }
  expect(fromV1Message(messages[0]).id, "H-CODEC-MESSAGES round trip id").toBe(host[0]?.id)
}

function checkPromptInputCodec(): void {
  const input = toV2PromptInput({ sessionID: SESSION_ID, text: "hi", agent: "build" })
  expect(input.sessionID).toBe(SESSION_ID)
  expect(input.text).toBe("hi")
  expect(input.agents).toEqual([{ name: "build" }])
  expect(Object.keys(input).sort()).toEqual(["agents", "sessionID", "text"])
}

function checkStatusCodec(): void {
  expect(toV1SessionStatus({ type: "idle" })).toEqual({ type: "idle" })
  expect(toV1SessionStatus({ type: "busy" })).toEqual({ type: "busy" })
  const retry = toV1SessionStatus({ type: "retry", attempt: 2, message: "rate limited", next: 42 })
  expect(retry).toEqual({ type: "retry", attempt: 2, message: "rate limited", next: 42 })
}

function checkToolResultCodec(): void {
  const result = toV1ToolResult({
    content: [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ],
    metadata: { truncated: false },
  })
  expect(result).toEqual({ output: "a\nb", metadata: { truncated: false } })
}

function checkToolOutputCodec(): void {
  expect(fromV1ToolOutput("hello v2 capture")).toEqual([{ type: "text", text: "hello v2 capture" }])
  expect(fromV1ToolOutput("x").length).toBe(1)
}

export const hCodecRows: ParityRow[] = defineGroup("H-CODEC", [
  {
    suffix: "MESSAGES",
    title: "the messages codec maps the recorded context entries to the V1 info/parts shape with ids preserved",
    kind: "hermetic",
    is: ["IS-4", "IS-8"],
    wave: 1,
    status: "checked",
    check: checkMessagesCodec,
  },
  {
    suffix: "PROMPT-INPUT",
    title: "the prompt input codec builds the OpenCode 2 SessionPromptInput with agents and no extra keys",
    kind: "hermetic",
    is: ["IS-4", "IS-8"],
    wave: 1,
    status: "checked",
    check: checkPromptInputCodec,
  },
  {
    suffix: "STATUS",
    title: "the status codec maps busy, idle and retry onto the V1 gate status shape",
    kind: "hermetic",
    is: ["IS-4", "IS-8"],
    wave: 1,
    status: "checked",
    check: checkStatusCodec,
  },
  {
    suffix: "TOOL-RESULT",
    title: "the tool result codec joins V2 tool contents into the single V1 output string with metadata",
    kind: "hermetic",
    is: ["IS-4", "IS-8"],
    wave: 1,
    status: "checked",
    check: checkToolResultCodec,
  },
  {
    suffix: "TOOL-OUTPUT",
    title: "the tool output codec wraps a V1 output string into the single-element V2 text content list",
    kind: "hermetic",
    is: ["IS-4", "IS-8"],
    wave: 1,
    status: "checked",
    check: checkToolOutputCodec,
  },
])
