import { expect } from "./bun-test-shim"

import type { Hooks } from "@opencode-ai/plugin"

import { createFakeV2Context } from "./fake-v2-context"
import {
  registerCompactionHookAdapters,
  resetCompactionAdaptationStateForTesting,
  type V2CompactionHookEvent,
} from "../hooks/adapt-compaction-hooks"
import { registerIdleContinuationAdapter, resetIdleContinuationStateForTesting } from "../hooks/adapt-idle-continuation"
import { releaseAllPromptAsyncReservationsForTesting } from "@oh-my-opencode/utils/prompt-async-gate"
import type { V2Runtime } from "../runtime/stop-v2-runtime"
import { defineGroup, type ParityRow, type ParityRowGroupItem } from "./rows"

// Wave-2 H-HOOK compaction rows and the H-ORCH single-edge row (plan task
// 19): the raw session.compaction.started event drives the V1 capture half,
// the compaction hook feeds the captured context into the request system
// parts without ever setting result, the ended event drives the restore half
// exactly once, and one idle edge produces exactly one continuation-owner
// consultation even when the host also fires experimental.idle.

const SESSION = "ses_h_orch"

type CompactionEngineCalls = {
  readonly compacting: Array<{ sessionID: string; context: string[] }>
  readonly autocontinue: Array<{ sessionID: string; message?: unknown; enabled: boolean }>
}

function compactionRuntimeOf(engine: Hooks): V2Runtime {
  return {
    directory: "ctx.location.directory",
    engine,
    tracker: { releasedDeps: new Set(), sharedHandles: [] },
    abort: new AbortController(),
    stop: async () => {},
    stopped: false,
  }
}

function compactionEngine(script: { readonly contextText?: string } = {}): {
  engine: Hooks
  calls: CompactionEngineCalls
} {
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

async function flushRaw(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function pushCompactionEvent(
  ctx: ReturnType<typeof createFakeV2Context>,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  ctx.__pushEvent({ type, created: 1, data })
  await flushRaw()
}

async function checkCompactionCapture(): Promise<void> {
  resetCompactionAdaptationStateForTesting()
  const ctx = createFakeV2Context()
  const { engine, calls } = compactionEngine({ contextText: "captured pre-compaction state" })
  await registerCompactionHookAdapters({ ctx, runtime: compactionRuntimeOf(engine) })
  await ctx.session.create({ id: SESSION })
  await pushCompactionEvent(ctx, "session.compaction.started", { sessionID: SESSION })
  expect(calls.compacting).toEqual([{ sessionID: SESSION, context: [] }])
  const event: V2CompactionHookEvent = { sessionID: SESSION, system: [{ type: "text", text: "base prompt" }] }
  await ctx.__fire("session", "compaction", event)
  expect(event.system.map((part) => part.text)).toEqual(["base prompt", "captured pre-compaction state"])
  expect(event.result, "the adapter never sets result: it would skip the model request").toBeUndefined()
}

async function checkCompactionAutocontinue(): Promise<void> {
  resetCompactionAdaptationStateForTesting()
  const ctx = createFakeV2Context()
  const { engine, calls } = compactionEngine()
  await registerCompactionHookAdapters({ ctx, runtime: compactionRuntimeOf(engine) })
  await ctx.session.create({ id: SESSION })
  await pushCompactionEvent(ctx, "session.compaction.started", { sessionID: SESSION })
  await pushCompactionEvent(ctx, "session.compaction.ended", { sessionID: SESSION, summary: "the finished summary" })
  await pushCompactionEvent(ctx, "session.compaction.ended", { sessionID: SESSION, summary: "the finished summary" })
  expect(calls.autocontinue).toEqual([{ sessionID: SESSION, message: "the finished summary", enabled: false }])
}

async function checkSingleIdleEdge(): Promise<void> {
  resetIdleContinuationStateForTesting()
  releaseAllPromptAsyncReservationsForTesting()
  const ctx = createFakeV2Context()
  const counters = { todo: 0, parentWake: 0 }
  const engine: Hooks = {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      counters.todo += 1
      counters.parentWake += 1
    },
  }
  const runtime = compactionRuntimeOf(engine)
  registerIdleContinuationAdapter({ ctx, runtime })
  await ctx.session.create({ id: SESSION })
  try {
    await ctx.__fire("session", "experimental.idle", { sessionID: SESSION, background: [] })
    expect(counters, "the marker hook never consults continuation owners").toEqual({ todo: 0, parentWake: 0 })
    await runtime.engine.event?.({
      event: { type: "session.idle", properties: { sessionID: SESSION } },
    } as Parameters<NonNullable<Hooks["event"]>>[0])
    await ctx.__fire("session", "experimental.idle", { sessionID: SESSION, background: [] })
    expect(counters, "one idle edge consults each owner exactly once").toEqual({ todo: 1, parentWake: 1 })
  } finally {
    releaseAllPromptAsyncReservationsForTesting()
  }
}

function row(suffix: string, title: string, check: () => void | Promise<void>): ParityRowGroupItem {
  return { suffix, title, kind: "hermetic", is: ["IS-4", "IS-8"], wave: 2, status: "checked", check }
}

export const hHookCompactionRows: ParityRow[] = defineGroup("H-HOOK", [
  row(
    "COMPACTION-CAPTURE",
    "session.compaction.started drives the V1 compacting half and the compaction hook feeds the captured context into event.system without setting result",
    checkCompactionCapture,
  ),
  row(
    "COMPACTION-AUTOCONTINUE",
    "session.compaction.ended drives experimental.compaction.autocontinue exactly once with the summary resolved from the event payload",
    checkCompactionAutocontinue,
  ),
])

export const hOrchRows: ParityRow[] = defineGroup("H-ORCH", [
  row(
    "SINGLE-EDGE",
    "a host firing both experimental.idle and the translated session.idle for one edge produces exactly one continuation-owner consultation",
    checkSingleIdleEdge,
  ),
])
