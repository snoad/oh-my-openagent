import { describe, expect, it } from "bun:test"

import type { SessionMessageInfo } from "@opencode/client"
import contextAFixture from "../parity/fixtures/host-2.4.1/context-a.json"
import contextBFixture from "../parity/fixtures/host-2.4.1/context-b.json"
import { fromV1Message, toV1Messages } from "./shape-codecs"

const SESSION_ID = "ses_deebc88bdffekHqnkcxwM2osoW"

type FixtureEnvelope = { readonly data: readonly unknown[] }

const contextA = (contextAFixture as FixtureEnvelope).data as unknown as SessionMessageInfo[]
const contextB = (contextBFixture as FixtureEnvelope).data as unknown as SessionMessageInfo[]

const conversational = (entries: readonly SessionMessageInfo[]): SessionMessageInfo[] =>
  entries.filter((entry) => entry.type === "user" || entry.type === "assistant")

// Strips the V2-only fields the strict V1 message shape cannot carry back:
// assistant snapshot and the streaming timestamps (firstToken/streamed).
function stripLossyV2Extras(entry: SessionMessageInfo): SessionMessageInfo {
  const clone = JSON.parse(JSON.stringify(entry)) as SessionMessageInfo & {
    snapshot?: unknown
    time: { firstToken?: unknown; streamed?: unknown }
  }
  if (clone.type === "assistant") {
    delete clone.snapshot
    delete clone.time.firstToken
    delete clone.time.streamed
  }
  return clone
}

describe("toV1Messages", () => {
  it("converts every conversational entry in order and skips the idle record", () => {
    // given
    const host = conversational(contextA)

    // when
    const messages = toV1Messages({ sessionID: SESSION_ID, data: contextA })

    // then
    expect(contextA.length).toBe(3)
    expect(messages.length).toBe(host.length)
    expect(messages[0]?.info.role).toBe("user")
    expect(messages[1]?.info.role).toBe("assistant")
  })

  it("preserves message ids, derives part ids and stamps the given sessionID", () => {
    // given
    const host = conversational(contextB)

    // when
    const messages = toV1Messages({ sessionID: SESSION_ID, data: contextB })

    // then
    const user = messages[0]
    expect(user?.info.id).toBe(host[0]?.id)
    expect(user?.parts[0]?.messageID).toBe(host[0]?.id)
    expect(user?.parts[0]?.sessionID).toBe(SESSION_ID)
    expect(user?.parts[0]?.type).toBe("text")
    expect(user?.parts[0]?.id).toBe(`${host[0]?.id}:0`)

    const assistant = messages[1]
    const toolPart = assistant?.parts[0]
    expect(toolPart?.type).toBe("tool")
    expect(toolPart?.id).toBe("call_1")
    expect(toolPart?.messageID).toBe(host[1]?.id)
    expect(toolPart?.sessionID).toBe(SESSION_ID)
  })

  it("produces exactly the V1 shape keys for user info and assistant info", () => {
    // when
    const messages = toV1Messages({ sessionID: SESSION_ID, data: contextB })

    // then
    expect(Object.keys(messages[0]?.info ?? {}).sort()).toEqual(["id", "role", "sessionID", "time"])
    expect(Object.keys(messages[1]?.info ?? {}).sort()).toEqual([
      "agent",
      "cost",
      "finish",
      "id",
      "modelID",
      "providerID",
      "role",
      "sessionID",
      "time",
      "tokens",
    ])
  })

  it("carries the native item id of assistant text parts as the V1 part id", () => {
    // given
    const host = conversational(contextA)

    // when
    const messages = toV1Messages({ sessionID: SESSION_ID, data: contextA })

    // then
    const textPart = messages[1]?.parts[0]
    expect(textPart?.id).toBe("msg_1")
    expect(textPart?.messageID).toBe(host[1]?.id)
  })

  it("produces exactly the V1 shape keys for text, tool and their states", () => {
    // when
    const textMessages = toV1Messages({ sessionID: SESSION_ID, data: contextA })
    const messages = toV1Messages({ sessionID: SESSION_ID, data: contextB })

    // then
    const textPart = textMessages[1]?.parts[0]
    expect(Object.keys(textPart ?? {}).sort()).toEqual([
      "id",
      "messageID",
      "metadata",
      "sessionID",
      "text",
      "type",
    ])
    const assistant = messages[1]
    expect(assistant?.parts.length).toBe(1)
    const toolPart = assistant?.parts[0] as { state: object }
    expect(Object.keys(assistant?.parts[0] ?? {}).sort()).toEqual([
      "callID",
      "id",
      "messageID",
      "metadata",
      "sessionID",
      "state",
      "tool",
      "type",
    ])
    expect(Object.keys(toolPart.state ?? {}).sort()).toEqual([
      "input",
      "metadata",
      "output",
      "status",
      "time",
      "title",
    ])
  })

  it("maps user and assistant text verbatim", () => {
    // given
    const host = conversational(contextA)

    // when
    const messages = toV1Messages({ sessionID: SESSION_ID, data: contextA })

    // then
    expect((messages[0]?.parts[0] as { text: string }).text).toBe("Reply with exactly: A_FINAL")
    expect((messages[1]?.parts[0] as { text: string }).text).toBe(host[1] && (host[1] as { content: [{ text: string }] }).content[0].text)
  })

  it("maps the context-b read tool call to a completed V1 tool state", () => {
    // when
    const messages = toV1Messages({ sessionID: SESSION_ID, data: contextB })
    const toolPart = messages[1]?.parts[0] as {
      callID: string
      tool: string
      state: {
        status: string
        input: unknown
        output: string
        title: string
        metadata: unknown
        time: { start: number; end: number }
      }
      metadata: { native?: unknown; executed?: boolean; ran?: number }
    }

    // then
    expect(toolPart.callID).toBe("call_1")
    expect(toolPart.tool).toBe("read")
    expect(toolPart.state.status).toBe("completed")
    expect(toolPart.state.input).toEqual({ path: "/tmp/oqa-v2-capture.xrswdN/proj/capture-b.txt" })
    expect(toolPart.state.output).toBe("Read file /tmp/oqa-v2-capture.xrswdN/proj/capture-b.txt, lines 1-1\n1: hello v2 capture")
    expect(toolPart.state.title).toBe("read")
    expect(toolPart.state.metadata).toEqual({ truncated: false })
    expect(toolPart.state.time).toEqual({ start: 1795585963898, end: 1795585963913 })
    expect(toolPart.metadata).toEqual({ executed: false, native: { itemId: "fc_1" }, ran: 1795585963902 })
  })

  it("enriches user info with the context agent and model when provided", () => {
    // when
    const messages = toV1Messages({
      sessionID: SESSION_ID,
      agent: "build",
      model: { id: "gpt-fake", providerID: "openai" },
      messages: contextA,
    })

    // then
    expect(messages[0]?.info.agent).toBe("build")
    expect(messages[0]?.info.model).toEqual({ providerID: "openai", modelID: "gpt-fake" })
  })

  it("throws naming an unknown message type", () => {
    // given
    const entry = { id: "msg_unknown", time: { created: 1 }, type: "quantum-anchor" } as unknown as SessionMessageInfo

    // when
    const failure = (() => {
      try {
        toV1Messages({ sessionID: SESSION_ID, messages: [entry] })
        return undefined
      } catch (error) {
        return error as Error
      }
    })()

    // then
    expect(failure?.message.includes("quantum-anchor")).toBe(true)
  })

  it("throws naming an unknown assistant content part type", () => {
    // given
    const host = conversational(contextA)
    const mutated = JSON.parse(JSON.stringify(host[1])) as { content: Array<{ type: string }> }
    mutated.content[0].type = "thought"
    const entry = mutated as unknown as SessionMessageInfo

    // when
    const failure = (() => {
      try {
        toV1Messages({ sessionID: SESSION_ID, messages: [entry] })
        return undefined
      } catch (error) {
        return error as Error
      }
    })()

    // then
    expect(failure?.message.includes("thought")).toBe(true)
  })
})

describe("fromV1Message round trip", () => {
  for (const [name, entries] of [
    ["context-a", contextA],
    ["context-b", contextB],
  ] as const) {
    it(`reproduces every conversational ${name} entry through the codec pair`, () => {
      // given
      const host = conversational(entries)
      const messages = toV1Messages({ sessionID: SESSION_ID, data: entries })

      // when
      const roundTripped = messages.map((message) => fromV1Message(message))

      // then
      expect(roundTripped.length).toBe(host.length)
      for (const [index, entry] of host.entries()) {
        expect(roundTripped[index], `${name} entry ${index} (${entry.type})`).toEqual(stripLossyV2Extras(entry))
      }
    })

    it(`is idempotent for unmodified ${name} messages`, () => {
      // given
      const messages = toV1Messages({ sessionID: SESSION_ID, data: entries })

      // when
      const reconverted = messages.map((message) =>
        toV1Messages({ sessionID: SESSION_ID, messages: [fromV1Message(message)] })[0],
      )

      // then
      expect(reconverted, `${name} reconverts to the same V1 shape`).toEqual(messages)
    })
  }
})
