import type { ToolDefinition } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode/plugin"

import { isRecord } from "../events/v2-event-payload"

// toV2ToolDefinition (plan task 25): the V1 registry tool (SRC/plugin/tool.ts
// shape) as an OpenCode 2 Tool.Info registration entry. The JSON Schema input
// is built at SETUP time from the per-arg schemas the V1 registry already
// attached through normalizeToolArgSchemas (SRC/plugin/normalize-tool-arg-
// schemas.ts), never inside the synchronous transform callback. execute
// bridges the OpenCode 2 ToolContext to the V1 ToolContext (sessionID,
// messageID, agent, abort signal, metadata; ask only when OpenCode 2 passes
// an equivalent - 2.4.1 passes none, so ask stays absent), awaits the V1
// execute and returns the SDK Tool.Result { output, metadata } (the model
// reads the output string); a V1 throw propagates unchanged and surfaces as
// the host's tool error state.

// Structural mirror of the pinned @opencode/plugin 2.4.1 promise ToolContext
// (Omit<Tool.Context, "progress" | "cancel"> plus signal and progress). The
// effect-branded SDK type cannot be imported here, so the host context is
// consumed through this mirror at the one registration boundary.
export type V2ToolExecuteContext = {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
  readonly progress?: (update: Record<string, unknown>) => Promise<void>
  readonly ask?: (input: V1AskInput) => Promise<void>
  readonly codemode?: boolean
}

export type V1AskInput = {
  readonly permission: string
  readonly patterns: string[]
  readonly always: string[]
  readonly metadata: Record<string, unknown>
}

// The V1 ToolContext fields the OpenCode 2 execution context can populate.
// directory and worktree have no OpenCode 2 counterpart (the host carries no
// location on Tool.Context), so tools reading them observe undefined.
export type V1ToolExecuteContext = {
  readonly sessionID: string
  readonly messageID: string
  readonly agent: string
  readonly directory?: string
  readonly worktree?: string
  readonly abort: AbortSignal
  readonly metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => void
  readonly ask?: (input: V1AskInput) => Promise<void>
}

export type V1ExecuteResult =
  string | { readonly output: string; readonly title?: string; readonly metadata?: Record<string, unknown> }

// Structural mirror of the V1 ToolDefinition whose args carry the JSON Schema
// override normalizeToolArgSchemas attached (_zod.toJSONSchema per arg).
export type V1ToolArgSchemaMirror = {
  readonly _zod: {
    readonly def?: { readonly type?: unknown }
    readonly toJSONSchema?: (() => unknown) | undefined
  }
}

export type V1ToolDefinitionMirror = {
  readonly description: string
  readonly args: Readonly<Record<string, V1ToolArgSchemaMirror>>
  readonly execute: (args: Record<string, unknown>, context: V1ToolExecuteContext) => Promise<V1ExecuteResult>
}

// The REAL SDK Tool.Result of the pinned @opencode/plugin 2.4.1, reached
// through the root type import (the only allowed @opencode/ type import): the
// tool domain hook's execute.after event carries `result: Tool.Result` and its
// completed branch is the completed result shape. Live row L-10 at HEAD
// a69eaf7234 proved the host stringifies a content array into "[object
// Object]" when execute returns { content: [...] }, so the model-visible text
// must ride the SDK `output` string field.
type ToolHookEvent = Parameters<Parameters<Plugin.Context["tool"]["hook"]>[1]>[0]
export type SdkToolResult = Extract<ToolHookEvent, { readonly status: "completed" }>["result"]

export type V2ToolExecute = (input: unknown, context: V2ToolExecuteContext) => Promise<SdkToolResult>

export type V2ToolDefinition = {
  readonly name: string
  readonly description: string
  readonly input: Record<string, unknown>
  readonly execute: V2ToolExecute
}

const JSON_SCHEMA_ROOT = "https://json-schema.org/draft/2020-12/schema"

// zod wrapper types whose input side is optional: the host's required array
// omits them (verified against the V1 baseline tool fixtures).
const OPTIONAL_ARG_DEF_TYPES = new Set(["optional", "default"])

function argJsonSchemaOf(arg: V1ToolArgSchemaMirror): unknown {
  const jsonSchema = arg._zod.toJSONSchema
  if (jsonSchema === undefined) return { type: "object", additionalProperties: true }
  return jsonSchema()
}

function argCoreType(arg: V1ToolArgSchemaMirror): unknown {
  return arg._zod.def?.type
}

// The full tool input schema the V1 host derives from the args record
// (v1-baseline/tools.json parameters shape): one object schema with the
// per-arg schemas as properties and the non-optional arg names required.
export function toolInputSchema(v1Args: Readonly<Record<string, V1ToolArgSchemaMirror>>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, arg] of Object.entries(v1Args)) {
    properties[name] = argJsonSchemaOf(arg)
    const defType = argCoreType(arg)
    if (typeof defType !== "string" || !OPTIONAL_ARG_DEF_TYPES.has(defType)) required.push(name)
  }
  return {
    $schema: JSON_SCHEMA_ROOT,
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
  }
}

function v1ContextOf(context: V2ToolExecuteContext): V1ToolExecuteContext {
  const ask = context.ask
  return {
    sessionID: context.sessionID,
    messageID: context.messageID,
    agent: context.agent,
    abort: context.signal,
    metadata: (input) => {
      void context.progress?.({
        ...(input.metadata ?? {}),
        ...(input.title === undefined ? {} : { title: input.title }),
      })
    },
    ...(ask === undefined ? {} : { ask: (input: V1AskInput) => ask(input) }),
  }
}

function v1OutputOf(result: V1ExecuteResult): string {
  return typeof result === "string" ? result : result.output
}

export function toV2ToolDefinition(name: string, v1: V1ToolDefinitionMirror): V2ToolDefinition {
  const input = toolInputSchema(v1.args)
  return {
    name,
    description: v1.description,
    input,
    execute: async (v2Input, context) => {
      const result = await v1.execute(isRecord(v2Input) ? v2Input : {}, v1ContextOf(context))
      const output = v1OutputOf(result)
      const metadata = typeof result === "string" ? undefined : result.metadata
      return {
        output,
        content: [{ type: "text" as const, text: output }],
        ...(metadata === undefined ? {} : { metadata }),
      }
    },
  }
}

// Narrow the SDK ToolsRecord entries into the codec's mirror at one boundary:
// the pinned SDK types carry zod brands the mirror reads structurally.
export function v1ToolMirrorOf(name: string, tool: ToolDefinition): V1ToolDefinitionMirror {
  return tool as unknown as V1ToolDefinitionMirror
}
