import { expect } from "./bun-test-shim"

import { registerToolHookAdapters, type V2ToolHookEngine } from "../hooks/adapt-tool-hooks"
import { createFakeV2Context } from "./fake-v2-context"
import { defineGroup, type ParityRow, type ParityRowGroupItem } from "./rows"

// Wave-2 H-HOOK rows owned by plan task 15: the tool execute hook adaptations.
// Each row drives the fake ctx tool domain with a recording stub engine and
// asserts the alias routing (the OpenCode 2 shell tool reaches the V1 bash
// guards), the args write-back, the veto propagation and the result rewrite
// through the task-11 codecs, including the failed-call mirror.

const SESSION = "ses_h_hook_tool"

function row(suffix: string, title: string, check: () => void | Promise<void>): ParityRowGroupItem {
  return { suffix, title, kind: "hermetic", is: ["IS-4"], wave: 2, status: "checked", check }
}

async function checkToolExecuteBefore(): Promise<void> {
  const ctx = createFakeV2Context()
  const tools: string[] = []
  const engine: V2ToolHookEngine = {
    "tool.execute.before": async (input, output) => {
      tools.push(input.tool)
      output.args.command = "guarded"
    },
  }
  registerToolHookAdapters(ctx, engine, () => {})
  const event = {
    tool: "shell",
    codemode: false,
    sessionID: SESSION,
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
    input: { command: "original" },
  }
  await ctx.__fire("tool", "execute.before", event)
  expect(tools, "the OpenCode 2 shell tool must route to the V1 bash guards").toEqual(["bash"])
  expect(event.input, "an in-place args mutation lands in event.input").toEqual({ command: "guarded" })

  const vetoCtx = createFakeV2Context()
  registerToolHookAdapters(
    vetoCtx,
    {
      "tool.execute.before": async () => {
        throw new Error("BLOCKED_BY_GUARD")
      },
    },
    () => {},
  )
  const vetoEvent = { ...event, input: { command: "sleep 60" } }
  let message = ""
  try {
    await vetoCtx.__fire("tool", "execute.before", vetoEvent)
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  expect(message, "a V1 throw propagates unchanged as the veto").toBe("BLOCKED_BY_GUARD")
  expect(vetoEvent.input).toEqual({ command: "sleep 60" })
}

async function checkToolExecuteAfter(): Promise<void> {
  const ctx = createFakeV2Context()
  const seen: Array<{ title: string; output: string; metadata: Record<string, unknown> }> = []
  const engine: V2ToolHookEngine = {
    "tool.execute.after": async (_input, output) => {
      seen.push({ title: output.title, output: output.output, metadata: { ...output.metadata } })
      output.output += "\n1: line 1 LINE#QPZ"
      output.metadata = { ...output.metadata, momus: true }
    },
  }
  registerToolHookAdapters(ctx, engine, () => {})
  const event = {
    tool: "read",
    codemode: false,
    sessionID: SESSION,
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
    input: { path: "/tmp/read.txt" },
    status: "completed",
    result: {
      content: [{ type: "text", text: "line 1" }],
      metadata: { truncated: false } as Record<string, unknown>,
    },
  }
  await ctx.__fire("tool", "execute.after", event)
  expect(seen[0]?.title, "an untitled result falls back to the V1 tool name").toBe("read")
  expect(seen[0]?.output, "the codec join reaches the V1 handler").toBe("line 1")
  expect(event.result.content, "an after-hook rewrite lands in the result content").toEqual([
    { type: "text", text: "line 1\n1: line 1 LINE#QPZ" },
  ])
  expect(event.result.metadata, "a replaced metadata object is written back").toEqual({ truncated: false, momus: true })

  const failed: unknown[] = []
  const failCtx = createFakeV2Context()
  registerToolHookAdapters(
    failCtx,
    {
      "tool.execute.after": async (_input, output) => {
        failed.push(output)
      },
    },
    () => {},
  )
  await failCtx.__fire("tool", "execute.after", {
    tool: "shell",
    codemode: false,
    sessionID: SESSION,
    agent: "build",
    messageID: "msg_1",
    id: "call_2",
    input: { command: "boom" },
    status: "error",
    error: { message: "boom" },
  })
  expect(failed, "a failed call mirrors the V1 undefined-output call").toEqual([undefined])
}

export const hHookToolRows: ParityRow[] = defineGroup("H-HOOK", [
  row(
    "TOOL-EXECUTE-BEFORE",
    "tool.execute.before routes the aliased V1 name into the engine, writes mutated args back and propagates a V1 throw as the veto",
    checkToolExecuteBefore,
  ),
  row(
    "TOOL-EXECUTE-AFTER",
    "tool.execute.after maps title, output and metadata both ways, lands rewrites in the result and mirrors failed calls with an undefined output",
    checkToolExecuteAfter,
  ),
])
