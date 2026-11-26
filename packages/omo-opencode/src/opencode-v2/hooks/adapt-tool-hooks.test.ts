import { describe, expect, it } from "bun:test"

import { createFakeV2Context } from "../parity/fake-v2-context"
import {
  registerToolHookAdapters,
  type V2ToolExecuteAfterEvent,
  type V2ToolExecuteBeforeEvent,
  type V2ToolHookEngine,
  type V2ToolHookResult,
} from "./adapt-tool-hooks"

// Tool execute hook adapters (plan task 15): execute.before routes the aliased
// V1 tool name into the engine, writes replaced args back and lets a V1 throw
// veto the call; execute.after maps title/output/metadata both ways and
// mirrors failed calls as the V1 undefined-output call.

const SESSION = "ses_tool_hooks"

type Marked = { name: string; sessionID: string }

function marker(): { marked: Marked[]; mark: (name: string, sessionID: string) => void } {
  const marked: Marked[] = []
  return { marked, mark: (name, sessionID) => marked.push({ name, sessionID }) }
}

function beforeEvent(input: Record<string, unknown> = { command: "original" }): V2ToolExecuteBeforeEvent {
  return {
    tool: "shell",
    codemode: false,
    sessionID: SESSION,
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
    input,
  }
}

function afterCompletedEvent(result: V2ToolHookResult): V2ToolExecuteAfterEvent {
  return { ...beforeEvent({ path: "/tmp/read.txt" }), tool: "read", status: "completed", result }
}

describe("registerToolHookAdapters", () => {
  describe("execute.before", () => {
    it("#given a registered adapter #when a before event fires #then the engine sees the aliased V1 name and ids", async () => {
      // given
      const ctx = createFakeV2Context()
      const calls: Array<{ tool: string; sessionID: string; callID: string; args: unknown }> = []
      const engine: V2ToolHookEngine = {
        "tool.execute.before": async (input, output) => {
          calls.push({ tool: input.tool, sessionID: input.sessionID, callID: input.callID, args: output.args })
        },
      }
      registerToolHookAdapters(ctx, engine, marker().mark)

      // when
      await ctx.__fire("tool", "execute.before", beforeEvent())

      // then
      expect(calls).toHaveLength(1)
      expect(calls[0]?.tool, "the OpenCode 2 shell tool must reach the V1 bash guards").toBe("bash")
      expect(calls[0]?.sessionID).toBe(SESSION)
      expect(calls[0]?.callID).toBe("call_1")
      expect(calls[0]?.args).toEqual({ command: "original" })
    })

    it("#given an in-place args mutation #when the V1 handler runs #then the mutation lands in event.input", async () => {
      // given
      const ctx = createFakeV2Context()
      const engine: V2ToolHookEngine = {
        "tool.execute.before": async (_input, output) => {
          output.args.command = "mutated"
        },
      }
      registerToolHookAdapters(ctx, engine, marker().mark)
      const event = beforeEvent()

      // when
      await ctx.__fire("tool", "execute.before", event)

      // then
      expect(event.input).toEqual({ command: "mutated" })
    })

    it("#given a replaced args object #when the V1 handler runs #then the replacement is written back to event.input", async () => {
      // given
      const ctx = createFakeV2Context()
      const engine: V2ToolHookEngine = {
        "tool.execute.before": async (_input, output) => {
          output.args = { command: "replaced" }
        },
      }
      registerToolHookAdapters(ctx, engine, marker().mark)
      const original = { command: "original" }
      const event = beforeEvent(original)

      // when
      await ctx.__fire("tool", "execute.before", event)

      // then
      expect(event.input).toEqual({ command: "replaced" })
      expect(event.input).not.toBe(original)
      expect(original).toEqual({ command: "original" })
    })

    it("#given a throwing V1 handler #when the event fires #then the hook rejects with the same message and event.input stays untouched", async () => {
      // given
      const ctx = createFakeV2Context()
      const engine: V2ToolHookEngine = {
        "tool.execute.before": async () => {
          throw new Error("BLOCKED_BY_GUARD")
        },
      }
      registerToolHookAdapters(ctx, engine, marker().mark)
      const event = beforeEvent({ command: "sleep 60" })

      // when
      let message = ""
      try {
        await ctx.__fire("tool", "execute.before", event)
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }

      // then
      expect(message).toBe("BLOCKED_BY_GUARD")
      expect(event.input).toEqual({ command: "sleep 60" })
    })

    it("#given a Code Mode call (LIM-19) #when the event carries codemode true #then the OpenCode 2 name passes unchanged", async () => {
      // given
      const ctx = createFakeV2Context()
      const tools: string[] = []
      const engine: V2ToolHookEngine = {
        "tool.execute.before": async (input) => {
          tools.push(input.tool)
        },
      }
      registerToolHookAdapters(ctx, engine, marker().mark)

      // when
      await ctx.__fire("tool", "execute.before", { ...beforeEvent(), codemode: true })

      // then
      expect(tools).toEqual(["shell"])
    })

    it("#given a registered adapter #when before events fire #then markHook records tool.execute.before per session", async () => {
      // given
      const ctx = createFakeV2Context()
      const { marked, mark } = marker()
      registerToolHookAdapters(ctx, {}, mark)

      // when
      await ctx.__fire("tool", "execute.before", beforeEvent())
      await ctx.__fire("tool", "execute.before", beforeEvent())

      // then
      expect(marked).toEqual([
        { name: "tool.execute.before", sessionID: SESSION },
        { name: "tool.execute.before", sessionID: SESSION },
      ])
    })

    it("#given an engine without the handler #when the event fires #then nothing is called and the input survives", async () => {
      // given
      const ctx = createFakeV2Context()
      registerToolHookAdapters(ctx, {}, marker().mark)
      const event = beforeEvent()

      // when
      await ctx.__fire("tool", "execute.before", event)

      // then
      expect(event.input).toEqual({ command: "original" })
    })
  })

  describe("execute.after", () => {
    type RecordedAfter = {
      tool: string
      sessionID: string
      callID: string
      args: unknown
      initialTitle: string
      initialOutput: string
      initialMetadata: Record<string, unknown>
      rawOutput: unknown
    }

    function snapshotAfter(
      input: { tool: string; sessionID: string; callID: string; args?: unknown },
      output: { title: string; output: string; metadata: Record<string, unknown> } | undefined,
    ): RecordedAfter {
      return {
        tool: input.tool,
        sessionID: input.sessionID,
        callID: input.callID,
        args: input.args,
        initialTitle: output?.title ?? "",
        initialOutput: output?.output ?? "",
        initialMetadata: output === undefined ? {} : { ...output.metadata },
        rawOutput: output,
      }
    }

    function recordingEngine(
      calls: RecordedAfter[],
      mutate?: (output: { title: string; output: string; metadata: Record<string, unknown> }) => void,
    ): V2ToolHookEngine {
      return {
        "tool.execute.after": async (input, output) => {
          calls.push(snapshotAfter(input, output))
          mutate?.(output)
        },
      }
    }

    it("#given a completed read result #when the event fires #then the V1 input and output are mapped", async () => {
      // given
      const ctx = createFakeV2Context()
      const calls: RecordedAfter[] = []
      registerToolHookAdapters(ctx, recordingEngine(calls), marker().mark)

      // when
      await ctx.__fire(
        "tool",
        "execute.after",
        afterCompletedEvent({
          content: [
            { type: "text", text: "line 1" },
            { type: "file", uri: "file:///tmp/read.txt", mime: "text/plain", name: "read.txt" },
          ],
          metadata: { truncated: false },
        }),
      )

      // then
      expect(calls).toHaveLength(1)
      expect(calls[0]?.tool).toBe("read")
      expect(calls[0]?.sessionID).toBe(SESSION)
      expect(calls[0]?.callID).toBe("call_1")
      expect(calls[0]?.args).toEqual({ path: "/tmp/read.txt" })
      expect(calls[0]?.initialTitle, "an untitled result falls back to the V1 tool name").toBe("read")
      expect(calls[0]?.initialOutput).toBe("line 1\n[file read.txt text/plain file:///tmp/read.txt]")
      expect(calls[0]?.initialMetadata).toEqual({ truncated: false })
    })

    it("#given an after-hook rewrite #when the handler appends hashline tags #then the result content carries them", async () => {
      // given
      const ctx = createFakeV2Context()
      const calls: RecordedAfter[] = []
      registerToolHookAdapters(
        ctx,
        recordingEngine(calls, (output) => {
          output.output += "\n1: line 1 LINE#QPZ"
        }),
        marker().mark,
      )
      const event = afterCompletedEvent({ content: [{ type: "text", text: "line 1" }] })

      // when
      await ctx.__fire("tool", "execute.after", event)

      // then
      expect(event.result?.content).toEqual([{ type: "text", text: "line 1\n1: line 1 LINE#QPZ" }])
    })

    it("#given a result title #when mapping #then it wins over the tool name, and a handler-set title is written back", async () => {
      // given
      const ctx = createFakeV2Context()
      const calls: RecordedAfter[] = []
      registerToolHookAdapters(
        ctx,
        recordingEngine(calls, (output) => {
          output.title = "momus review"
        }),
        marker().mark,
      )
      const event = afterCompletedEvent({ content: [{ type: "text", text: "x" }], title: "Read file" })

      // when
      await ctx.__fire("tool", "execute.after", event)

      // then
      expect(calls[0]?.initialTitle, "a V2 result title overrides the tool-name fallback").toBe("Read file")
      expect(event.result?.title).toBe("momus review")
    })

    it("#given a handler-replaced metadata object #when the handler runs #then the replacement is written back", async () => {
      // given
      const ctx = createFakeV2Context()
      const calls: RecordedAfter[] = []
      registerToolHookAdapters(
        ctx,
        recordingEngine(calls, (output) => {
          output.metadata = { ...output.metadata, momus: true }
        }),
        marker().mark,
      )
      const event = afterCompletedEvent({ content: [{ type: "text", text: "x" }], metadata: { truncated: false } })

      // when
      await ctx.__fire("tool", "execute.after", event)

      // then
      expect(event.result?.metadata).toEqual({ truncated: false, momus: true })
    })

    it("#given an unchanged output string #when the handler is a no-op #then the result content is preserved untouched", async () => {
      // given
      const ctx = createFakeV2Context()
      const calls: RecordedAfter[] = []
      registerToolHookAdapters(ctx, recordingEngine(calls), marker().mark)
      const content = [
        { type: "text", text: "line 1" },
        { type: "file", uri: "file:///img.png", mime: "image/png", name: "img.png" },
      ] as const
      const event = afterCompletedEvent({ content })

      // when
      await ctx.__fire("tool", "execute.after", event)

      // then
      expect(event.result?.content).toBe(content)
    })

    it("#given a failed call #when the event carries status error #then the engine is called with output undefined", async () => {
      // given
      const ctx = createFakeV2Context()
      const calls: RecordedAfter[] = []
      registerToolHookAdapters(ctx, recordingEngine(calls), marker().mark)

      // when
      await ctx.__fire("tool", "execute.after", {
        ...beforeEvent({ path: "/tmp/read.txt" }),
        status: "error",
        error: { message: "boom" },
      })

      // then
      expect(calls).toHaveLength(1)
      expect(calls[0]?.tool).toBe("bash")
      expect(calls[0]?.rawOutput).toBeUndefined()
    })

    it("#given a registered adapter #when after events fire #then markHook records tool.execute.after per session", async () => {
      // given
      const ctx = createFakeV2Context()
      const { marked, mark } = marker()
      registerToolHookAdapters(ctx, {}, mark)

      // when
      await ctx.__fire("tool", "execute.after", afterCompletedEvent({ content: [{ type: "text", text: "x" }] }))

      // then
      expect(marked).toEqual([{ name: "tool.execute.after", sessionID: SESSION }])
    })
  })
})
