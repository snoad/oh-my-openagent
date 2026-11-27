import { describe, expect, it } from "bun:test"

import type { Hooks } from "@opencode-ai/plugin"
import type { SessionPromptAsyncData } from "@opencode-ai/sdk"

import { captureConsoleLines } from "../parity/fake-v2-engine"
import { createFakeV2Context } from "../parity/fake-v2-context"
import { createV2ClientShim } from "../client/v2-client-shim"
import {
  dispatchInternalPrompt,
  releaseAllPromptAsyncReservationsForTesting,
} from "@oh-my-opencode/utils/prompt-async-gate"
import { registerIdleContinuationAdapter, resetIdleContinuationStateForTesting } from "./adapt-idle-continuation"

// Idle continuation adapter (plan task 19). The ONLY continuation trigger is
// the translated V1 session.idle event delivered through engine.event, so
// every V1 idle consumer runs exactly as on V1 and admits through the prompt
// gate; the experimental.idle host hook is registered as a marker only. A
// per-session budget bounds consecutive gate-dispatched internal admissions,
// resets on a real user prompt and refuses idle delivery when exhausted.

const SESSION = "ses_idle"

type V1AsyncInput = Omit<SessionPromptAsyncData, "url">
type OwnerName = "todo" | "parentWake"

type IdleHarness = {
  readonly ctx: ReturnType<typeof createFakeV2Context>
  readonly runtime: { engine: Hooks }
  readonly counters: Record<OwnerName, number>
}

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

async function createIdleHarness(options: {
  readonly owners?: readonly OwnerName[]
  readonly idleBudget?: number
  readonly distinctTexts?: boolean
}): Promise<IdleHarness> {
  resetIdleContinuationStateForTesting()
  releaseAllPromptAsyncReservationsForTesting()
  const ctx = createFakeV2Context()
  const shim = createV2ClientShim(ctx, { promptWaitPollMs: 1 })
  const counters: Record<OwnerName, number> = { todo: 0, parentWake: 0 }
  const owners = options.owners ?? ["todo"]
  let sequence = 0
  const engine: Hooks = {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sessionID = (event.properties as { sessionID?: string }).sessionID
      if (sessionID === undefined) return
      for (const owner of owners) {
        counters[owner] += 1
        const text = options.distinctTexts === true ? `${owner} continuation ${++sequence}` : `${owner} continuation`
        await dispatchInternalPrompt<V1AsyncInput>({
          mode: "async",
          client: shim,
          sessionID,
          source: `test:${owner}-owner`,
          settleMs: 0,
          queueBehavior: "defer",
          input: { path: { id: sessionID }, body: { parts: [{ type: "text", text }] } },
        })
      }
    },
  }
  const runtime = runtimeOf(engine)
  registerIdleContinuationAdapter({ ctx, runtime, idleBudget: options.idleBudget })
  await ctx.session.create({ id: SESSION })
  return { ctx, runtime: runtime as unknown as IdleHarness["runtime"], counters }
}

async function deliverIdleEdge(harness: IdleHarness): Promise<void> {
  await harness.runtime.engine.event?.({
    event: { type: "session.idle", properties: { sessionID: SESSION } },
  } as Parameters<NonNullable<Hooks["event"]>>[0])
}

// The fake host keeps the session busy from an admission until its turn ends,
// exactly like a real host; ending the turn lets the next gate dispatch run.
async function endTurn(harness: IdleHarness): Promise<void> {
  await harness.ctx.session.interrupt({ sessionID: SESSION })
}

function promptCount(ctx: ReturnType<typeof createFakeV2Context>): number {
  return ctx.__calls.filter((call) => call.op === "session.prompt").length
}

async function internalAdmission(ctx: ReturnType<typeof createFakeV2Context>, text: string): Promise<void> {
  const shim = createV2ClientShim(ctx, { promptWaitPollMs: 1 })
  try {
    await dispatchInternalPrompt<V1AsyncInput>({
      mode: "async",
      client: shim,
      sessionID: SESSION,
      source: "test:internal-admission",
      settleMs: 0,
      queueBehavior: "defer",
      input: { path: { id: SESSION }, body: { parts: [{ type: "text", text }] } },
    })
  } finally {
    releaseAllPromptAsyncReservationsForTesting()
  }
}

describe("registerIdleContinuationAdapter", () => {
  it("#given a pending todo owner #when one idle edge is delivered #then exactly one continuation is admitted through the gate", async () => {
    // given
    const harness = await createIdleHarness({ owners: ["todo"] })

    // when
    await deliverIdleEdge(harness)

    // then
    expect(promptCount(harness.ctx)).toBe(1)
    const admission = harness.ctx.__calls.find((call) => call.op === "session.prompt")?.args[0] as {
      metadata?: { omo?: { internal?: boolean } }
    }
    expect(admission.metadata?.omo?.internal, "idle continuations admit through the tagged shim route").toBe(true)
  })

  it("#given two rapid idle edges #when no gate release happens between them #then the gate dedupes to one admission", async () => {
    // given
    const harness = await createIdleHarness({ owners: ["todo"] })

    // when
    await deliverIdleEdge(harness)
    await deliverIdleEdge(harness)

    // then
    expect(promptCount(harness.ctx)).toBe(1)
  })

  it("#given the host fires experimental.idle and the translated idle for one edge #when both arrive #then each owner counter advances exactly once", async () => {
    // given
    const harness = await createIdleHarness({ owners: ["todo", "parentWake"] })

    // when
    await harness.ctx.__fire("session", "experimental.idle", { sessionID: SESSION, background: [] })
    await deliverIdleEdge(harness)
    await harness.ctx.__fire("session", "experimental.idle", { sessionID: SESSION, background: [] })

    // then
    expect(harness.counters.todo, "the marker hook never consults the todo owner").toBe(1)
    expect(harness.counters.parentWake, "the marker hook never consults the parent-wake owner").toBe(1)
  })

  it("#given a non-empty background list #when experimental.idle fires #then no admission happens", async () => {
    // given
    const harness = await createIdleHarness({ owners: ["todo", "parentWake"] })

    // when
    await harness.ctx.__fire("session", "experimental.idle", {
      sessionID: SESSION,
      background: [{ kind: "shell", sessionID: SESSION, shellID: "sh_1", command: "bun test" }],
    })

    // then
    expect(promptCount(harness.ctx)).toBe(0)
    expect(harness.counters.todo).toBe(0)
    expect(harness.counters.parentWake).toBe(0)
  })

  it("#given the budget set to 2 #when three idle edges arrive #then the third is refused with the exhaustion log, an internal admission never resets and a user prompt does", async () => {
    // given
    const captured = captureConsoleLines()
    let harness: IdleHarness
    try {
      harness = await createIdleHarness({ owners: ["todo"], idleBudget: 2, distinctTexts: true })
      await deliverIdleEdge(harness)
      await endTurn(harness)
      await releaseAllPromptAsyncReservationsForTesting()
      await deliverIdleEdge(harness)
      await endTurn(harness)
      await releaseAllPromptAsyncReservationsForTesting()

      // when
      await deliverIdleEdge(harness)
      const refusedAt = promptCount(harness.ctx)
      await internalAdmission(harness.ctx, "unrelated internal dispatch")
      await endTurn(harness)
      await deliverIdleEdge(harness)
      const refusedAfterInternal = promptCount(harness.ctx)
      await harness.ctx.session.prompt({ sessionID: SESSION, text: "real user turn" })
      await endTurn(harness)
      await deliverIdleEdge(harness)

      // then
      expect(refusedAt, "the third idle edge must not admit").toBe(2)
      expect(refusedAfterInternal, "an internal admission must not reset the budget").toBe(3)
      expect(promptCount(harness.ctx), "a user prompt resets the budget and the next edge admits").toBe(5)
      const exhaustionLines = captured.lines.filter((line) => line.includes("[opencode-v2] idle budget exhausted"))
      expect(exhaustionLines.length, "the exhaustion line is logged for every refused edge").toBe(2)
      process.stdout.write(`[qa] exhaustion lines: ${JSON.stringify(exhaustionLines)}\n`)
    } finally {
      captured.restore()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })
})
