import type { Event } from "@opencode-ai/sdk"
import type { Hooks } from "@opencode-ai/plugin"

import type { SessionPromptInput } from "@opencode/client"
import { observeShimAdmissions } from "../client/prompt-raw"
import type { V2ShimContext } from "../client/shim-context"
import { sessionHookTarget } from "./adapt-prompt-hook"
import { markHook } from "../runtime/hook-markers"
import type { V2RuntimePluginContext } from "../runtime/start-v2-runtime"
import type { V2Runtime } from "../runtime/stop-v2-runtime"

// Idle continuation adapter (plan task 19). The ONLY continuation trigger is
// the translated V1 session.idle event delivered through engine.event: the
// V1 idle consumers (todo continuation, background parent wake, compaction
// autocontinue) run exactly as on V1 and admit through the prompt gate, so
// reservation and dedupe stay in the gate and only what the gate dispatched
// counts as an admission. The experimental.idle host hook is registered as a
// marker only and never consults continuation owners, so a host that fires
// both the hook and session.status idle for one edge produces exactly one
// owner consultation. A plugin that always admits would loop forever on a
// 2.2.1+ host, so a per-session budget bounds consecutive gate-dispatched
// internal admissions: it resets ONLY on an admitted prompt without the
// omo.internal tag (a real user prompt, observed through the prompt hook)
// and when exhausted the idle edge is refused with the exhaustion log.

const IDLE_ADMISSION_BUDGET = 200

export type V2ExperimentalIdleEvent = {
  readonly sessionID: string
  readonly background: ReadonlyArray<unknown>
}

type PromptResetEvent = {
  readonly sessionID: string
  readonly metadata?: Record<string, unknown>
}

function isInternalAdmission(metadata: PromptResetEvent["metadata"]): boolean {
  const omo: unknown = metadata?.["omo"]
  if (typeof omo !== "object" || omo === null || Array.isArray(omo)) return false
  const record = omo as Record<string, unknown>
  return record["internal"] === true
}

const remainingBudget = new Map<string, number>()

export function resetIdleContinuationStateForTesting(): void {
  remainingBudget.clear()
}

export function registerIdleContinuationAdapter(input: {
  readonly ctx: V2RuntimePluginContext
  readonly runtime: V2Runtime
  readonly idleBudget?: number
}): void {
  const budget = input.idleBudget ?? IDLE_ADMISSION_BUDGET

  const hookCtx = sessionHookTarget(input.ctx)
  void hookCtx.session.hook("experimental.idle", (event: V2ExperimentalIdleEvent) => {
    markHook("experimental.idle", event.sessionID)
  })

  void hookCtx.session.hook("prompt", (event: PromptResetEvent) => {
    if (isInternalAdmission(event.metadata)) return
    remainingBudget.set(event.sessionID, budget)
  })

  observeShimAdmissions(input.ctx as V2ShimContext, (admission) => {
    if (!isInternalAdmission(admission.metadata)) return
    const remaining = remainingBudget.get(admission.sessionID) ?? budget
    remainingBudget.set(admission.sessionID, remaining - 1)
  })

  gateIdleDelivery(input.runtime, budget)
}

function gateIdleDelivery(runtime: V2Runtime, budget: number): void {
  const original = runtime.engine.event
  if (typeof original !== "function") return
  const gated: NonNullable<Hooks["event"]> = async (delivery) => {
    const event = delivery.event as unknown as { type?: string; properties?: unknown }
    const properties = event.properties as Record<string, unknown> | undefined
    const sessionID = typeof properties?.sessionID === "string" ? properties.sessionID : undefined
    if (event.type === "session.idle" && sessionID !== undefined && (remainingBudget.get(sessionID) ?? budget) <= 0) {
      console.log("[opencode-v2] idle budget exhausted", { sessionID })
      return
    }
    await original?.(delivery)
  }
  runtime.engine.event = gated
}
