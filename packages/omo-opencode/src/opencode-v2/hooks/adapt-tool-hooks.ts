import type { Hooks } from "@opencode-ai/plugin"

import { fromV1ToolOutput, toV1ReadToolResult, toV1ToolResult } from "../client/tool-result-codecs"
import type { V2ToolContentOut, V2ToolResultInput } from "../client/shape-codec-types"
import { isRecord } from "../events/v2-event-payload"
import type { V2RuntimePluginContext } from "../runtime/start-v2-runtime"
import { toV1ToolNameForCall } from "./tool-name-aliases"

// registerToolHookAdapters (plan task 15): bridges the two OpenCode 2 tool
// hooks to the V1 engine's tool execute handlers. execute.before calls
// engine["tool.execute.before"] with the aliased V1 tool name
// (toV1ToolNameForCall), the event's sessionID and call id and the mutable
// input as the V1 args record; an in-place args mutation lands on event.input
// directly, a replaced args object is written back, and a V1 throw propagates
// unchanged (that is the veto). execute.after builds the V1 input plus the
// output { title, output, metadata } through the task-11 codecs, writes title,
// output (through fromV1ToolOutput) and metadata back when the handler changed
// them, and mirrors failed calls as the V1 undefined-output call
// (SRC/plugin/tool-execute-after.ts:49-50 returns before any hook runs).

export type V2ToolExecuteBeforeEvent = {
  readonly tool: string
  readonly info?: unknown
  readonly codemode: boolean
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  input: unknown
}

export type V2ToolHookResult = {
  title?: string
  output?: unknown
  content?: string | readonly V2ToolContentOut[]
  metadata?: Record<string, unknown>
}

export type V2ToolExecuteAfterEvent = V2ToolExecuteBeforeEvent &
  ({ readonly status: "completed"; result: V2ToolHookResult } | { readonly status: "error"; readonly error: unknown })

type V2HookRegistration = { readonly dispose: () => Promise<void> }

// The plugin ctx the tool hook adapters consume: the runtime context plus the
// host tool hook registrar (the static shim context slice omits hook, so the
// registration adapter narrows the ctx at that boundary).
export type V2ToolHookContext = V2RuntimePluginContext & {
  readonly tool: V2RuntimePluginContext["tool"] & {
    hook(
      name: "execute.before",
      callback: (event: V2ToolExecuteBeforeEvent) => void | Promise<void>,
    ): Promise<V2HookRegistration>
    hook(
      name: "execute.after",
      callback: (event: V2ToolExecuteAfterEvent) => void | Promise<void>,
    ): Promise<V2HookRegistration>
  }
}

export type V2ToolHookEngine = Pick<Hooks, "tool.execute.before" | "tool.execute.after">

// The V1 handler implementation accepts output undefined for failed calls
// (SRC/plugin/tool-execute-after.ts:42); the published Hooks type omits the
// undefined branch, so the adapter reads the handler through this tolerant
// mirror at one boundary.
type V1ToolExecuteAfterHandler = (
  input: {
    readonly tool: string
    readonly sessionID: string
    readonly callID: string
    readonly args?: Record<string, unknown>
  },
  output: { title: string; output: string; metadata: Record<string, unknown> } | undefined,
) => Promise<void> | void

// The hook input carries the schema-decoded tool arguments; only records can
// back the V1 args contract, anything else runs against a detached record.
function recordArgsOf(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {}
}

function codecInputOf(result: V2ToolHookResult): V2ToolResultInput {
  const rawContent =
    typeof result.content === "string" ? [{ type: "text" as const, text: result.content }] : result.content
  const content =
    rawContent ??
    (typeof result.output === "string" && result.output.length > 0
      ? [{ type: "text" as const, text: result.output }]
      : undefined)
  return {
    ...(result.title === undefined ? {} : { title: result.title }),
    ...(content === undefined ? {} : { content }),
    ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
  }
}

export function registerToolHookAdapters(
  ctx: V2ToolHookContext,
  engine: V2ToolHookEngine,
  markHook: (name: string, sessionID: string) => void,
): void {
  void ctx.tool.hook("execute.before", async (event) => {
    markHook("tool.execute.before", event.sessionID)
    const handler = engine["tool.execute.before"]
    if (handler === undefined) return
    const baseArgs = recordArgsOf(event.input)
    const output: { args: Record<string, unknown>; message?: string } = { args: baseArgs }
    await handler(
      { tool: toV1ToolNameForCall(event.tool, event.codemode), sessionID: event.sessionID, callID: event.id },
      output,
    )
    if (output.args !== baseArgs) event.input = output.args
    // The V1 host vetoes a call through output.message (bash-file-read-guard,
    // non-interactive-env, prometheus-md-only); on OpenCode 2 the same veto is
    // a hook rejection carrying that message verbatim.
    if (typeof output.message === "string" && output.message.length > 0) {
      throw new Error(output.message)
    }
  })

  void ctx.tool.hook("execute.after", async (event) => {
    markHook("tool.execute.after", event.sessionID)
    const handler = engine["tool.execute.after"] as V1ToolExecuteAfterHandler | undefined
    if (handler === undefined) return
    const tool = toV1ToolNameForCall(event.tool, event.codemode)
    const input = { tool, sessionID: event.sessionID, callID: event.id, args: recordArgsOf(event.input) }
    const result = event.status === "completed" ? event.result : undefined
    if (result === undefined) {
      await handler(input, undefined)
      return
    }
    const v1Result = tool === "read" ? toV1ReadToolResult(codecInputOf(result)) : toV1ToolResult(codecInputOf(result))
    const output = { title: v1Result.title ?? tool, output: v1Result.output, metadata: v1Result.metadata ?? {} }
    const initialOutput = output.output
    const initialTitle = output.title
    const initialMetadata = output.metadata
    await handler(input, output)
    if (output.output !== initialOutput) result.content = fromV1ToolOutput(output.output)
    if (output.title !== initialTitle) result.title = output.title
    if (output.metadata !== initialMetadata) result.metadata = output.metadata
  })
}
