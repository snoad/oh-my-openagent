import { describe, expect, it } from "bun:test"

import type { Hooks } from "@opencode-ai/plugin"

import { createFakeV2Context } from "../parity/fake-v2-context"
import {
  registerCompactionHookAdapters,
  resetCompactionAdaptationStateForTesting,
  type V2CompactionHookEvent,
} from "./adapt-compaction-hooks"

// Compaction hook adapter (plan task 19): the raw session.compaction.started
// event drives the V1 capture/inject half, the session compaction hook feeds
// the captured context into the compaction request system parts and the raw
// ended event drives the restore half exactly once through
// experimental.compaction.autocontinue with the summary resolved from the
// event payload (never ctx.session.compact, which returns the inbox item).

const SESSION = "ses_compaction"

function runtimeOf(engine: Hooks) {
  return {
    directory: "ctx.location.directory",
    engine,
    tracker: { releasedDeps: new Set(), sharedHandles: [] },
    abort: new AbortController(),
    stop: async () => {},
    stopped: false,
  }
}

type CompactionEngineCalls = {
  readonly compacting: Array<{ sessionID: string; context: string[] }>
  readonly autocontinue: Array<{ sessionID: string; message?: unknown; enabled: boolean }>
}

function compactionEngine(script: { readonly contextText?: string }): { engine: Hooks; calls: CompactionEngineCalls } {
  const calls: CompactionEngineCalls = { compacting: [], autocontinue: [] }
  const engine = {
    "experimental.session.compacting": async (input: { sessionID: string }, output: { context: string[] }) => {
      calls.compacting.push({ sessionID: input.sessionID, context: [...output.context] })
      if (script.contextText !== undefined) output.context.push(script.contextText)
    },
    "experimental.compaction.autocontinue": async (
      input: { sessionID: string; message?: unknown },
      output: { enabled: boolean },
    ) => {
      calls.autocontinue.push({ sessionID: input.sessionID, message: input.message, enabled: output.enabled })
    },
  } as unknown as Hooks
  return { engine, calls }
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function pushEvent(ctx: ReturnType<typeof createFakeV2Context>, type: string, data: Record<string, unknown>) {
  ctx.__pushEvent({ type, created: 1, data })
  await flushAsync()
  await flushAsync()
}

async function registeredHarness(script: { readonly contextText?: string } = {}) {
  resetCompactionAdaptationStateForTesting()
  const ctx = createFakeV2Context()
  const { engine, calls } = compactionEngine(script)
  await registerCompactionHookAdapters({ ctx, runtime: runtimeOf(engine) })
  await ctx.session.create({ id: SESSION })
  return { ctx, calls }
}

describe("registerCompactionHookAdapters", () => {
  it("#given a session.compaction.started raw event #when the loop delivers it #then the V1 compacting half runs and the context is captured", async () => {
    // given
    const { ctx, calls } = await registeredHarness({ contextText: "captured pre-compaction state" })

    // when
    await pushEvent(ctx, "session.compaction.started", { sessionID: SESSION })

    // then
    expect(calls.compacting).toEqual([{ sessionID: SESSION, context: [] }])
  })

  it("#given captured context #when the compaction hook fires #then text parts join event.system and result stays unset", async () => {
    // given
    const { ctx } = await registeredHarness({ contextText: "captured pre-compaction state" })
    await pushEvent(ctx, "session.compaction.started", { sessionID: SESSION })
    const event: V2CompactionHookEvent = {
      sessionID: SESSION,
      system: [{ type: "text", text: "base prompt" }],
    }

    // when
    await ctx.__fire("session", "compaction", event)

    // then
    expect(event.system.map((part) => part.text)).toEqual(["base prompt", "captured pre-compaction state"])
    expect(event.result, "the adapter must never set result: it would skip the model request").toBeUndefined()
  })

  it("#given one compaction lifecycle #when ended arrives twice #then the restore half runs exactly once with the payload summary", async () => {
    // given
    const { ctx, calls } = await registeredHarness()
    await pushEvent(ctx, "session.compaction.started", { sessionID: SESSION })

    // when
    await pushEvent(ctx, "session.compaction.ended", { sessionID: SESSION, summary: "the finished summary" })
    await pushEvent(ctx, "session.compaction.ended", { sessionID: SESSION, summary: "the finished summary" })

    // then
    expect(calls.autocontinue).toEqual([{ sessionID: SESSION, message: "the finished summary", enabled: false }])
  })

  it("#given a second compaction cycle #when started runs again #then the next ended restores once more", async () => {
    // given
    const { ctx, calls } = await registeredHarness()
    await pushEvent(ctx, "session.compaction.started", { sessionID: SESSION })
    await pushEvent(ctx, "session.compaction.ended", { sessionID: SESSION, summary: "first" })
    await pushEvent(ctx, "session.compaction.started", { sessionID: SESSION })

    // when
    await pushEvent(ctx, "session.compaction.ended", { sessionID: SESSION, summary: "second" })

    // then
    expect(calls.autocontinue).toHaveLength(2)
    expect(calls.autocontinue[1]?.message).toBe("second")
  })

  it("#given a failed compaction #when ended never arrives #then no restore runs and the captured context is dropped", async () => {
    // given
    const { ctx, calls } = await registeredHarness({ contextText: "stale context" })
    await pushEvent(ctx, "session.compaction.started", { sessionID: SESSION })

    // when
    await pushEvent(ctx, "session.compaction.failed", { sessionID: SESSION })
    const event: V2CompactionHookEvent = { sessionID: SESSION, system: [] }
    await ctx.__fire("session", "compaction", event)

    // then
    expect(calls.autocontinue).toEqual([])
    expect(event.system).toEqual([])
  })

  it("#given no capture ran #when the compaction hook fires #then event.system stays untouched", async () => {
    // given
    const { ctx } = await registeredHarness()
    const event: V2CompactionHookEvent = { sessionID: SESSION, system: [{ type: "text", text: "base" }] }

    // when
    await ctx.__fire("session", "compaction", event)

    // then
    expect(event.system).toEqual([{ type: "text", text: "base" }])
  })
})
