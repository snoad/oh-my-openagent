import type { Hooks } from "@opencode-ai/plugin"

import { toV1Messages } from "../client/to-v1-messages"
import type { V1MessageWithParts } from "../client/shape-codec-types"
import type { V2RuntimePluginContext } from "../runtime/start-v2-runtime"
import { markHook } from "../runtime/hook-markers"
import type { V2Runtime } from "../runtime/stop-v2-runtime"
import { storageEntriesOf, systemTextsOf, writeBackSystem, type V2HookContextEvent } from "./context-message-codec"
import { writeBackMessages } from "./context-message-writeback"
import { v1ModelStub, v1ProviderStub, v1UserMessageStub, type V1UserMessageWithVariant } from "./context-v1-inputs"

// Context hook adapter (plan task 17): one ctx.session.hook("context", ...)
// registration that routes the OpenCode 2 request payload through the three
// V1 request transforms - experimental.chat.system.transform, then
// experimental.chat.messages.transform, then chat.params - and writes every
// result back in place. The context hook runs immediately before each
// agent-loop model request, so this is the V2 seam for GAP-4 request
// transforms.

type V2ContextHookRegistrationContext = V2RuntimePluginContext & {
  readonly session: V2RuntimePluginContext["session"] & {
    readonly hook: (name: "context", callback: (event: V2HookContextEvent) => void | Promise<void>) => Promise<unknown>
  }
}

// Generation knobs the V2 request carries natively; every other chat.params
// option entry is a provider option.
const GENERATION_OPTION_KEYS = new Set([
  "maxTokens",
  "temperature",
  "topP",
  "topK",
  "frequencyPenalty",
  "presencePenalty",
  "seed",
  "stop",
])

export function registerContextHookAdapter(input: {
  readonly ctx: V2RuntimePluginContext
  readonly runtime: V2Runtime
  // Task 27: the request-level tool filter (hidden V1 tools entries) runs
  // before the transforms so they see the filtered tool set.
  readonly filterTools?: (event: V2HookContextEvent) => void
}): void {
  const ctx = input.ctx as V2ContextHookRegistrationContext
  void ctx.session.hook("context", async (event) => {
    markHook("context", event.sessionID)
    input.filterTools?.(event)
    await applySystemTransform(input.runtime.engine, event)
    await applyMessagesTransform(input.runtime.engine, event)
    await applyParamsTransform(input.runtime.engine, event)
  })
}

async function applySystemTransform(engine: Hooks, event: V2HookContextEvent): Promise<void> {
  const handler = engine["experimental.chat.system.transform"]
  if (handler === undefined) return
  const output = { system: systemTextsOf(event.system) }
  await handler({ sessionID: event.sessionID, model: v1ModelStub(event.model) }, output)
  writeBackSystem(event.system, output.system)
  markHook("experimental.chat.system.transform", event.sessionID)
}

async function applyMessagesTransform(engine: Hooks, event: V2HookContextEvent): Promise<void> {
  const handler = engine["experimental.chat.messages.transform"]
  if (handler === undefined) return
  const messages: V1MessageWithParts[] = toV1Messages({
    sessionID: event.sessionID,
    agent: event.agent,
    model: { id: event.model.id, providerID: event.model.providerID },
    messages: storageEntriesOf(event),
  })
  // The tolerant V1 message mirror crosses into the strict Hooks signature at
  // this one boundary (the task-14 tolerant-boundary decision); the handler
  // mutates the same array object, so the mirror stays the source of truth.
  const output: { messages: V1MessageWithParts[] } = { messages }
  await handler({}, output as unknown as Parameters<NonNullable<Hooks["experimental.chat.messages.transform"]>>[1])
  writeBackMessages(event, output.messages)
  markHook("experimental.chat.messages.transform", event.sessionID)
}

type V1ChatParamsOutput = {
  temperature: number
  topP: number
  topK: number
  maxOutputTokens: number | undefined
  options: Record<string, unknown>
}

function numberOption(options: Record<string, unknown>, key: string): number | undefined {
  const value = options[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

// Apply-back semantics: generation knobs apply only when the handler actually
// changed the seeded host value (writing the seed back would force defaults
// such as temperature 0 onto a host that never carried one), provider option
// entries merge unconditionally, and a handler-deleted option entry is removed
// from the host options as well.
async function applyParamsTransform(engine: Hooks, event: V2HookContextEvent): Promise<void> {
  const handler = engine["chat.params"]
  if (handler === undefined) return
  const seededOptions: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event.options)) {
    if (!GENERATION_OPTION_KEYS.has(key)) seededOptions[key] = value
  }
  const seeds = {
    temperature: numberOption(event.options, "temperature"),
    topP: numberOption(event.options, "topP"),
    topK: numberOption(event.options, "topK"),
    maxTokens: numberOption(event.options, "maxTokens"),
  }
  // The V1 chat.params output types these knobs as numbers even when the host
  // never carried one; NaN marks "absent" so an untouched handler applies
  // nothing (the finite guards below drop NaN), while a handler-written value
  // still lands. maxOutputTokens is `number | undefined`, so undefined is its
  // honest absent marker.
  const params: V1ChatParamsOutput = {
    temperature: seeds.temperature ?? Number.NaN,
    topP: seeds.topP ?? Number.NaN,
    topK: seeds.topK ?? Number.NaN,
    maxOutputTokens: seeds.maxTokens,
    options: seededOptions,
  }
  const message: V1UserMessageWithVariant = v1UserMessageStub({
    sessionID: event.sessionID,
    agent: event.agent,
    model: event.model,
  })
  await handler(
    {
      sessionID: event.sessionID,
      agent: event.agent,
      model: v1ModelStub(event.model),
      provider: v1ProviderStub(event.model.providerID),
      message,
    },
    params,
  )
  applyParamsBack(event.options, params, seeds)
  markHook("chat.params", event.sessionID)
}

type ParamSeeds = {
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxTokens?: number
}

function applyParamsBack(options: Record<string, unknown>, params: V1ChatParamsOutput, seeds: ParamSeeds): void {
  applyChangedNumber(options, "temperature", params.temperature, seeds.temperature)
  applyChangedNumber(options, "topP", params.topP, seeds.topP)
  applyChangedNumber(options, "topK", params.topK, seeds.topK)
  if (params.maxOutputTokens !== undefined && Number.isFinite(params.maxOutputTokens)) {
    if (params.maxOutputTokens !== seeds.maxTokens) options["maxTokens"] = params.maxOutputTokens
  }
  const seededKeys = Object.keys(params.options)
  Object.assign(options, params.options)
  for (const key of seededKeys) {
    if (!(key in params.options)) delete options[key]
  }
}

function applyChangedNumber(
  options: Record<string, unknown>,
  key: string,
  next: number,
  seed: number | undefined,
): void {
  if (typeof next !== "number" || !Number.isFinite(next)) return
  if (next === seed) return
  options[key] = next
}
