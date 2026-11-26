import { expect } from "./bun-test-shim"

import type { SessionPromptAsyncData, SessionPromptData } from "@opencode-ai/sdk"
import {
  dispatchInternalPrompt,
  releaseAllPromptAsyncReservationsForTesting,
} from "@oh-my-opencode/utils/prompt-async-gate"
import type { SessionMessageInfo } from "@opencode/client"
import { createV2ClientShim } from "../client/v2-client-shim"
import { createFakeV2Context, type FakeV2Context } from "./fake-v2-context"
import { defineGroup, type ParityRow, type ParityRowGroupItem } from "./rows"

// Wave-1 H-CLIENT rows (plan task 12): one per V1 client shim session method,
// each driving the real shim over the hermetic fake ctx and asserting the
// routed ctx call (__calls) plus the returned V1 shape. The admission rows go
// through dispatchInternalPrompt (gate-routed dispatch is the only sanctioned
// consumption route, so these rows never access the raw prompt methods) and
// release the gate state they take. The message-domain rows live in
// rows-h-client-messages.ts, the lifecycle rows in rows-h-client-lifecycle.ts
// and the misc-domain rows in rows-h-client-misc.ts; all four files feed the
// H-CLIENT id space.

type Shim = ReturnType<typeof createV2ClientShim>
type V1AsyncInput = Omit<SessionPromptAsyncData, "url">
type V1SyncInput = Omit<SessionPromptData, "url"> & { readonly signal?: AbortSignal }

export function rowSetup(): { ctx: FakeV2Context; shim: Shim } {
  const ctx = createFakeV2Context()
  return { ctx, shim: createV2ClientShim(ctx, { promptWaitPollMs: 1 }) }
}

export async function newSession(shim: Shim, ctx: FakeV2Context): Promise<string> {
  const created = await shim.session.create({
    body: { title: "h-client" },
    query: { directory: ctx.location.directory },
  })
  const id = created.data?.id
  if (id === undefined) throw new Error("session create returned no id")
  return id
}

export function callOps(ctx: FakeV2Context, op: string): number {
  return ctx.__calls.filter((call) => call.op === op).length
}

export function row(suffix: string, title: string, check: () => void | Promise<void>): ParityRowGroupItem {
  return { suffix, title, kind: "hermetic", is: ["IS-4", "IS-8"], wave: 1, status: "checked", check }
}

export function seedAssistant(ctx: FakeV2Context, sessionID: string, text = "row reply"): void {
  const record = ctx.__sessions.get(sessionID)
  if (record === undefined) throw new Error(`unknown session ${sessionID}`)
  const entry: SessionMessageInfo = {
    id: "msg_row_assistant",
    type: "assistant",
    agent: "build",
    model: { id: "claude-x", providerID: "anthropic" },
    content: [{ type: "text", text }],
    time: { created: 10, completed: 11 },
  }
  record.context.push(entry)
}

export async function dispatchViaGate(shim: Shim, sessionID: string, text: string): Promise<void> {
  try {
    await dispatchInternalPrompt<V1AsyncInput>({
      mode: "async",
      client: shim,
      sessionID,
      input: { path: { id: sessionID }, body: { parts: [{ type: "text", text }] } },
      source: "v2-parity:h-client",
      settleMs: 0,
      queueBehavior: "defer",
    })
  } finally {
    releaseAllPromptAsyncReservationsForTesting()
  }
}

async function checkPromptAsync(): Promise<void> {
  const { ctx, shim } = rowSetup()
  const sessionID = await newSession(shim, ctx)
  await dispatchViaGate(shim, sessionID, "row admission")
  const admission = ctx.__calls.find((call) => call.op === "session.prompt")?.args[0]
  expect(admission).toMatchObject({ sessionID, text: "row admission", metadata: { omo: { internal: true } } })
  expect(callOps(ctx, "session.prompt")).toBe(1)
}

async function checkPrompt(): Promise<void> {
  const { ctx, shim } = rowSetup()
  const sessionID = await newSession(shim, ctx)
  seedAssistant(ctx, sessionID)
  const controller = new AbortController()
  try {
    const dispatched = dispatchInternalPrompt<V1SyncInput>({
      mode: "sync",
      client: shim,
      sessionID,
      input: {
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: "row sync" }] },
        signal: controller.signal,
      },
      source: "v2-parity:h-client",
      settleMs: 0,
      queueBehavior: "defer",
    })
    controller.abort()
    const result = await dispatched
    expect(result.status).toBe("dispatched")
    if (result.status !== "dispatched") return
    const envelope = result.response as { data?: { info?: { role?: string } } }
    expect(envelope.data?.info?.role).toBe("assistant")
  } finally {
    releaseAllPromptAsyncReservationsForTesting()
  }
  expect(callOps(ctx, "session.interrupt")).toBe(1)
}

async function checkGateRace(): Promise<void> {
  const { ctx, shim } = rowSetup()
  const sessionID = await newSession(shim, ctx)
  try {
    const first = dispatchInternalPrompt<V1AsyncInput>({
      mode: "async",
      client: shim,
      sessionID,
      input: { path: { id: sessionID }, body: { parts: [{ type: "text", text: "first" }] } },
      source: "v2-parity:h-gate:first",
      settleMs: 0,
      queueBehavior: "defer",
    })
    await Promise.resolve()
    const second = await dispatchInternalPrompt<V1AsyncInput>({
      mode: "async",
      client: shim,
      sessionID,
      input: { path: { id: sessionID }, body: { parts: [{ type: "text", text: "second" }] } },
      source: "v2-parity:h-gate:second",
      settleMs: 0,
      queueBehavior: "defer",
    })
    expect((await first).status).toBe("dispatched")
    expect(second.status === "reserved" || second.status === "active").toBe(true)
  } finally {
    releaseAllPromptAsyncReservationsForTesting()
  }
  expect(callOps(ctx, "session.prompt")).toBe(1)
}

export const hClientRows: ParityRow[] = defineGroup("H-CLIENT", [
  row(
    "PROMPT-ASYNC",
    "session.promptAsync admits once through the raw call site with the omo.internal tag",
    checkPromptAsync,
  ),
  row(
    "PROMPT",
    "session.prompt admits, waits for idle, honors the abort signal through interrupt and returns the assistant pair",
    checkPrompt,
  ),
])

export const hGateRows: ParityRow[] = defineGroup("H-GATE", [
  row(
    "RACE-COLLAPSE",
    "two internal dispatches racing for one idle V2-backed session collapse to one admitted prompt",
    checkGateRace,
  ),
])
