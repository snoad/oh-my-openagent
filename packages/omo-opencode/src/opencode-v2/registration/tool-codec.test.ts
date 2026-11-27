import { describe, expect, it } from "bun:test"
import type { Plugin } from "@opencode/plugin"

import {
  toolInputSchema,
  toV2ToolDefinition,
  type V1ToolArgSchemaMirror,
  type V1ToolDefinitionMirror,
  type V1ToolExecuteContext,
  type V2ToolExecute,
} from "./tool-codec"

function argOf(jsonSchema: Record<string, unknown>, defType = "string"): V1ToolArgSchemaMirror {
  return { _zod: { def: { type: defType }, toJSONSchema: () => jsonSchema } }
}

function stubTool(execute: V1ToolDefinitionMirror["execute"]): V1ToolDefinitionMirror {
  return {
    description: "stub tool",
    args: {
      pattern: argOf({ type: "string", description: "The pattern" }),
      path: argOf({ type: "string", description: "The path" }, "optional"),
      limit: argOf({ type: "number" }, "default"),
    },
    execute,
  }
}

describe("toolInputSchema", () => {
  it("#given V1 args carrying the normalizeToolArgSchemas JSON Schema override #when the input schema is built #then it equals the V1 baseline parameters shape (object, properties, required, $schema)", () => {
    // given
    const args = {
      pattern: argOf({ type: "string", description: "The regex pattern" }),
      path: argOf({ type: "string", description: "The directory" }, "optional"),
      include: argOf({ type: "string", description: "The include glob" }, "optional"),
    }

    // when
    const schema = toolInputSchema(args)

    // then: the same shape the V1 host serves on /experimental/tool
    expect(schema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        pattern: { type: "string", description: "The regex pattern" },
        path: { type: "string", description: "The directory" },
        include: { type: "string", description: "The include glob" },
      },
      required: ["pattern"],
    })
  })

  it("#given args that are all optional wrappers #when the input schema is built #then the required key is omitted like the V1 host does", () => {
    // given
    const args = {
      limit: argOf({ type: "number" }, "optional"),
      from_date: argOf({ type: "string" }, "optional"),
    }

    // when
    const schema = toolInputSchema(args)

    // then
    expect(Object.hasOwn(schema, "required")).toBe(false)
    expect(schema.type).toBe("object")
  })

  it("#given an arg whose JSON Schema override is missing #when the input schema is built #then the arg falls back to a permissive object schema instead of throwing", () => {
    // given
    const args = { mystery: { _zod: {} } satisfies V1ToolArgSchemaMirror }

    // when
    const schema = toolInputSchema(args)

    // then
    expect(schema.properties).toEqual({ mystery: { type: "object", additionalProperties: true } })
    expect(schema.required).toEqual(["mystery"])
  })
})

describe("toV2ToolDefinition execute", () => {
  it("#given a V1 tool returning a string #when the V2 execute runs #then the result is the SDK shape carrying the V1 string as output", async () => {
    // given
    const seenContexts: unknown[] = []
    const v2 = toV2ToolDefinition(
      "grep",
      stubTool(async (args, context) => {
        seenContexts.push(context)
        return `matched ${String(args.pattern)}`
      }),
    )

    // when
    const result = await v2.execute(
      { pattern: "parity" },
      { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", signal: new AbortController().signal },
    )

    // then
    expect(result).toEqual({ output: "matched parity", content: [{ type: "text", text: "matched parity" }] })
  })

  it("#given a V1 tool returning the object result form #when the V2 execute runs #then the output string and metadata land in the SDK result fields", async () => {
    // given
    const v2 = toV2ToolDefinition(
      "task",
      stubTool(async () => ({ title: "task", output: "done\n<task_metadata>x</task_metadata>" })),
    )

    // when
    const result = await v2.execute(
      {},
      {
        sessionID: "ses_1",
        agent: "build",
        messageID: "msg_1",
        id: "call_1",
        signal: new AbortController().signal,
      },
    )

    // then
    expect(result).toEqual({
      output: "done\n<task_metadata>x</task_metadata>",
      content: [{ type: "text", text: "done\n<task_metadata>x</task_metadata>" }],
    })
  })

  it("#given a V1 object result carrying metadata #when the V2 execute runs #then the metadata rides the SDK result metadata field", async () => {
    // given
    const v2 = toV2ToolDefinition(
      "task",
      stubTool(async () => ({ output: "done", metadata: { k: 1 } })),
    )

    // when
    const result = await v2.execute(
      {},
      {
        sessionID: "ses_1",
        agent: "build",
        messageID: "msg_1",
        id: "call_1",
        signal: new AbortController().signal,
      },
    )

    // then
    expect(result).toEqual({
      output: "done",
      content: [{ type: "text", text: "done" }],
      metadata: { k: 1 },
    })
  })

  it("#given the built execute #when its return type is checked #then it is assignable to the SDK Tool.Result the after hook receives", () => {
    // given: the SDK result type derived from the pinned plugin package
    type ToolHookEvent = Parameters<Parameters<Plugin.Context["tool"]["hook"]>[1]>[0]
    type SdkToolResult = Extract<ToolHookEvent, { readonly status: "completed" }>["result"]
    const v2 = toV2ToolDefinition(
      "grep",
      stubTool(async () => "x"),
    )

    // when: the execute return must satisfy the SDK result type
    const asSdk: (input: unknown, context: Parameters<V2ToolExecute>[1]) => Promise<SdkToolResult> = v2.execute

    // then: the assignment compiled (type-level) and the function is intact
    expect(typeof asSdk).toBe("function")
  })

  it("#given a V1 execute that rejects #when the V2 execute awaits it #then the same error propagates as the tool error", async () => {
    // given
    const v2 = toV2ToolDefinition(
      "boom",
      stubTool(async () => {
        throw new Error("registry exploded")
      }),
    )

    // when
    let message = ""
    try {
      await v2.execute(
        {},
        {
          sessionID: "ses_1",
          agent: "build",
          messageID: "msg_1",
          id: "call_1",
          signal: new AbortController().signal,
        },
      )
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    // then
    expect(message).toBe("registry exploded")
  })

  it("#given non-record tool input #when the V2 execute runs #then the V1 execute still receives a record", async () => {
    // given
    const receivedArgs: unknown[] = []
    const v2 = toV2ToolDefinition(
      "grep",
      stubTool(async (args) => {
        receivedArgs.push(args)
        return "ok"
      }),
    )

    // when
    await v2.execute("not-a-record", {
      sessionID: "ses_1",
      agent: "build",
      messageID: "msg_1",
      id: "call_1",
      signal: new AbortController().signal,
    })

    // then
    expect(receivedArgs).toEqual([{}])
  })
})

describe("toV2ToolDefinition context bridge", () => {
  it("#given the OpenCode 2 execution context #when the V1 execute runs #then the V1 context carries sessionID, messageID, agent and the abort signal", async () => {
    // given
    const controller = new AbortController()
    let received: V1ToolExecuteContext | undefined
    const v2 = toV2ToolDefinition(
      "grep",
      stubTool(async (_args, context) => {
        received = context
        return "ok"
      }),
    )

    // when
    await v2.execute(
      {},
      {
        sessionID: "ses_x",
        agent: "sisyphus",
        messageID: "msg_x",
        id: "call_x",
        signal: controller.signal,
      },
    )

    // then
    expect(received.sessionID).toBe("ses_x")
    expect(received.messageID).toBe("msg_x")
    expect(received.agent).toBe("sisyphus")
    expect(received.abort).toBe(controller.signal)
  })

  it("#given the host passes no ask equivalent #when the V1 context is built #then ask is absent, and metadata routes into progress", async () => {
    // given
    const progressUpdates: unknown[] = []
    let received: V1ToolExecuteContext | undefined
    const v2 = toV2ToolDefinition(
      "task",
      stubTool(async (_args, context) => {
        context.metadata({ title: "t", metadata: { k: 1 } })
        received = context
        return "ok"
      }),
    )

    // when
    await v2.execute(
      {},
      {
        sessionID: "ses_x",
        agent: "sisyphus",
        messageID: "msg_x",
        id: "call_x",
        signal: new AbortController().signal,
        progress: async (update) => {
          progressUpdates.push(update)
        },
      },
    )

    // then
    expect(received.ask).toBeUndefined()
    expect(progressUpdates).toEqual([{ k: 1, title: "t" }])
  })
})
