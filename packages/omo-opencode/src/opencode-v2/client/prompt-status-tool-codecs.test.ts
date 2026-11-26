import { describe, expect, it } from "bun:test"

import { fromV1ToolOutput, toV1SessionStatus, toV1ToolResult, toV2PromptInput } from "./shape-codecs"
import type { V1FilePartInput, V1TextPartInput } from "./shape-codecs"

const SESSION_ID = "ses_deebc88bdffekHqnkcxwM2osoW"

const textPart = (text: string): V1TextPartInput => ({
  id: "part_1",
  sessionID: SESSION_ID,
  messageID: "msg_1",
  type: "text",
  text,
})

const filePart = (): V1FilePartInput => ({
  id: "part_2",
  sessionID: SESSION_ID,
  messageID: "msg_1",
  type: "file",
  mime: "image/png",
  filename: "shot.png",
  url: "file:///tmp/shot.png",
})

describe("toV2PromptInput", () => {
  it("emits exactly the sessionID and text keys for a plain prompt", () => {
    // when
    const input = toV2PromptInput({ sessionID: SESSION_ID, text: "hi" })

    // then
    expect(Object.keys(input).sort()).toEqual(["sessionID", "text"])
    expect(input.text).toBe("hi")
    expect(input.sessionID).toBe(SESSION_ID)
  })

  it("wraps the agent into the agents name list", () => {
    // when
    const input = toV2PromptInput({ sessionID: SESSION_ID, text: "hi", agent: "build" })

    // then
    expect(input.agents).toEqual([{ name: "build" }])
    expect(Object.keys(input).sort()).toEqual(["agents", "sessionID", "text"])
  })

  it("passes metadata through untouched", () => {
    // given
    const metadata = { omo: { internal: true } }

    // when
    const input = toV2PromptInput({ sessionID: SESSION_ID, text: "hi", metadata })

    // then
    expect(input.metadata).toEqual({ omo: { internal: true } })
    expect(input.metadata).toBe(metadata)
  })

  it("derives the text from the text parts when no explicit text is given", () => {
    // when
    const input = toV2PromptInput({ sessionID: SESSION_ID, parts: [textPart("a"), textPart("b")] })

    // then
    expect(input.text).toBe("a\nb")
  })

  it("derives files from file parts and keeps an empty text for attachment-only prompts", () => {
    // when
    const input = toV2PromptInput({ sessionID: SESSION_ID, parts: [filePart()] })

    // then
    expect(input.text).toBe("")
    expect(input.files).toEqual([{ uri: "file:///tmp/shot.png", name: "shot.png" }])
  })

  it("throws when neither text nor parts are given", () => {
    // when
    const failure = (() => {
      try {
        toV2PromptInput({ sessionID: SESSION_ID })
        return undefined
      } catch (error) {
        return error as Error
      }
    })()

    // then
    expect(failure?.message.includes("text")).toBe(true)
  })
})

describe("toV1SessionStatus", () => {
  it("maps the busy status onto exactly the V1 busy shape", () => {
    // when
    const status = toV1SessionStatus({ type: "busy" })

    // then
    expect(status).toEqual({ type: "busy" })
    expect(Object.keys(status)).toEqual(["type"])
  })

  it("maps the idle status onto exactly the V1 idle shape", () => {
    // when
    const status = toV1SessionStatus({ type: "idle" })

    // then
    expect(status).toEqual({ type: "idle" })
  })

  it("keeps attempt, message and next on retry and drops the V2-only action", () => {
    // given
    const v2 = {
      type: "retry",
      attempt: 2,
      message: "rate limited",
      next: 1795585964000,
      action: { reason: "rate_limit", provider: "openai", title: "Retry", message: "waiting", label: "retry" },
    }

    // when
    const status = toV1SessionStatus(v2)

    // then
    expect(status).toEqual({ type: "retry", attempt: 2, message: "rate limited", next: 1795585964000 })
    expect(Object.keys(status).sort()).toEqual(["attempt", "message", "next", "type"])
  })
})

describe("toV1ToolResult", () => {
  it("joins text contents into the single V1 output string", () => {
    // when
    const result = toV1ToolResult({
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
      metadata: { truncated: false },
    })

    // then
    expect(result).toEqual({ output: "a\nb", metadata: { truncated: false } })
    expect(Object.keys(result).sort()).toEqual(["metadata", "output"])
  })

  it("keeps the title when the V2 result carries one", () => {
    // when
    const result = toV1ToolResult({ title: "Read file", content: [{ type: "text", text: "x" }] })

    // then
    expect(result).toEqual({ title: "Read file", output: "x" })
  })

  it("serializes file contents as a named output line instead of dropping them", () => {
    // when
    const result = toV1ToolResult({
      content: [{ type: "file", uri: "file:///tmp/shot.png", mime: "image/png", name: "shot.png" }],
    })

    // then
    expect(result.output).toBe("[file shot.png image/png file:///tmp/shot.png]")
  })
})

describe("fromV1ToolOutput", () => {
  it("wraps a plain output string into the single-element V2 text content list", () => {
    // when
    const content = fromV1ToolOutput("hello v2 capture")

    // then
    expect(content).toEqual([{ type: "text", text: "hello v2 capture" }])
    expect(content.length).toBe(1)
  })
})
