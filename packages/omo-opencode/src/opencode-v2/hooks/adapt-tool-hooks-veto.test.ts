import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"

import { computeLineHash } from "../../tools/hashline-edit/hash-computation"
import { createHashlineReadEnhancerHook } from "../../hooks/hashline-read-enhancer/hook"
import { normalizeV2ReadOutput } from "../client/tool-result-codecs"
import { createFakeV2Context } from "../parity/fake-v2-context"
import { registerToolHookAdapters, type V2ToolHookEngine } from "./adapt-tool-hooks"

// The guard veto bridge and the read hashline bridge (live row L-09): a V1
// guard that sets output.message must reject the OpenCode 2 hook with that
// message so the host blocks the call, and a read result must carry the V1
// LINE#ID tags after the after-hooks ran.

const SESSION = "ses_tool_veto"

const GUARD_MESSAGE =
  "Prefer the Read tool over `cat`/`head`/`tail` for reading file contents. The Read tool provides line numbers and hash anchors for precise editing."

const FIXTURE_OUTPUT = readFileSync(
  fileURLToPath(new URL("./fixtures/read-tool-result-2.4.1.txt", import.meta.url)),
  "utf8",
).replace(/\n$/, "")

function marker(): { marked: string[]; mark: (name: string, sessionID: string) => void } {
  const marked: string[] = []
  return { marked, mark: (name) => marked.push(name) }
}

describe("execute.before message veto (L-09 scenario C)", () => {
  it("#given a V1 guard that sets output.message #when the event fires #then the hook rejects with exactly that text and input stays untouched", async () => {
    // given
    const ctx = createFakeV2Context()
    const engine: V2ToolHookEngine = {
      "tool.execute.before": async (_input, output) => {
        output.message = GUARD_MESSAGE
      },
    }
    registerToolHookAdapters(ctx, engine, marker().mark)
    const event = {
      tool: "shell",
      codemode: false,
      sessionID: SESSION,
      agent: "build",
      messageID: "msg_1",
      id: "call_1",
      input: { command: "cat /tmp/proj/capture-b.txt" },
    }

    // when
    let message = ""
    try {
      await ctx.__fire("tool", "execute.before", event)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    // then
    expect(message).toBe(GUARD_MESSAGE)
    expect(event.input).toEqual({ command: "cat /tmp/proj/capture-b.txt" })
  })

  it("#given a veto plus an args mutation in the same handler run #when the event fires #then input reflects the handler mutation before the rejection", async () => {
    // given
    const ctx = createFakeV2Context()
    const engine: V2ToolHookEngine = {
      "tool.execute.before": async (_input, output) => {
        output.args = { command: "cat /cleaned" }
        output.message = "veto text"
      },
    }
    registerToolHookAdapters(ctx, engine, marker().mark)
    const event = {
      tool: "shell",
      codemode: false,
      sessionID: SESSION,
      agent: "build",
      messageID: "msg_1",
      id: "call_1",
      input: { command: "cat /orig" } as unknown,
    }

    // when
    await expect(ctx.__fire("tool", "execute.before", event)).rejects.toThrow("veto text")

    // then
    expect(event.input).toEqual({ command: "cat /cleaned" })
  })

  it("#given an empty message #when the event fires #then no veto happens and the args write-back still lands", async () => {
    // given
    const ctx = createFakeV2Context()
    const engine: V2ToolHookEngine = {
      "tool.execute.before": async (_input, output) => {
        output.args.command = "ls -la"
        output.message = ""
      },
    }
    registerToolHookAdapters(ctx, engine, marker().mark)
    const event = {
      tool: "shell",
      codemode: false,
      sessionID: SESSION,
      agent: "build",
      messageID: "msg_1",
      id: "call_1",
      input: { command: "orig" } as unknown,
    }

    // when
    await ctx.__fire("tool", "execute.before", event)

    // then
    expect(event.input).toEqual({ command: "ls -la" })
  })
})

describe("read hashline tags (L-09 scenario B)", () => {
  function enhancerEngine(enabled: boolean): V2ToolHookEngine {
    const hook = createHashlineReadEnhancerHook({} as PluginInput, { hashline_edit: { enabled } })
    return {
      "tool.execute.after": async (input, output) => {
        const mirror = { title: output.title, output: output.output, metadata: output.metadata }
        await hook["tool.execute.after"]({ tool: input.tool, sessionID: input.sessionID, callID: input.callID }, mirror)
        output.output = mirror.output
        output.title = mirror.title
        output.metadata = mirror.metadata
      },
    }
  }

  it("#given the real captured OpenCode 2 read output #when the after-hooks run with hashline enabled #then the result carries the V1 LINE#ID tags", async () => {
    // given
    const ctx = createFakeV2Context()
    registerToolHookAdapters(ctx, enhancerEngine(true), marker().mark)
    const event = {
      tool: "read",
      codemode: false,
      sessionID: SESSION,
      agent: "build",
      messageID: "msg_1",
      id: "call_1",
      input: { path: "/tmp/proj/capture-b.txt" } as unknown,
      status: "completed" as const,
      result: { content: [{ type: "text" as const, text: FIXTURE_OUTPUT }] },
    }

    // when
    await ctx.__fire("tool", "execute.after", event)

    // then
    const text = (event.result.content as ReadonlyArray<{ type: string; text: string }>)[0]?.text ?? ""
    const lines = text.split("\n")
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe(`1#${computeLineHash(1, "alpha line one")}|alpha line one`)
    expect(lines[1]).toBe(`2#${computeLineHash(2, "beta line two")}|beta line two`)
    expect(lines[2]).toBe(`3#${computeLineHash(3, "gamma line three")}|gamma line three`)
  })

  it("#given a V1-shaped read output #when the codec normalizes it #then nothing changes", () => {
    // given
    const v1Shaped = "1: first line\n2: second line"

    // then
    expect(normalizeV2ReadOutput(v1Shaped)).toBe(v1Shaped)
    expect(normalizeV2ReadOutput("no numbered lines here")).toBe("no numbered lines here")
  })
})
