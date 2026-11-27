// Plan source (task 23): the registration recompute engine. Recomputes the
// registration plan once at start, then on the OpenCode 2 events that carry
// host config changes (config.updated and the *.updated domain events) with
// an injectable debounce. One recompute refreshes the task-22 snapshot,
// reads the pristine base ONLY through it, runs the ordered step registry
// (tools first, then the V1 config pipeline step, then the later-task
// transforms) and reloads ONLY the domains whose plan section changed; an
// unchanged plan never reloads, because a reload publishes *.updated events
// that would re-trigger the debounce and oscillate.

import { log } from "../../shared"

import { subscribeV2RawEvents, type V2EventSubscription } from "../events/subscribe-v2-events"
import { jsonDeepEqual, noopPlanOf } from "./plan-diff"
import { createPlanStepRegistry, type PlanStepRegistry } from "./plan-steps"
import type { PlanSourceContext, PlanSourceEngine, PlanSourceScheduler } from "./plan-source-context"
import { computeRegistrationPlan } from "./project-config"
import { type PlanDomain, type RegistrationPlan } from "./registration-plan"
import { guardReplayStep } from "./replay-guard"
import { createHostStateSnapshot, type HostStateSnapshot } from "./host-state-snapshot"

// Verified against the pinned @opencode/schema 2.4.1 (the host's own event
// schemas): config.updated, agent.updated, command.updated, model.updated and
// provider.updated exist there. tool.updated and mcp.updated do NOT exist on
// 2.4.1 (the tool and mcp schema modules carry no updated events), so their
// recompute rides on config.updated.
export const PLAN_SOURCE_EVENT_TYPES = [
  "config.updated",
  "agent.updated",
  "command.updated",
  "model.updated",
  "provider.updated",
] as const

export const DEFAULT_PLAN_DEBOUNCE_MS = 500

const LOG_MARKER = "[opencode-v2] plan-source"

export type PlanSource = {
  readonly getPlan: () => RegistrationPlan | undefined
  readonly snapshot: HostStateSnapshot
  readonly registerStep: PlanStepRegistry["register"]
  readonly recompute: () => Promise<void>
  readonly idle: () => Promise<void>
  readonly subscription: V2EventSubscription
}

export type CreatePlanSourceOptions = {
  readonly snapshot?: HostStateSnapshot
  readonly scheduler?: PlanSourceScheduler
  readonly debounceMs?: number
  readonly signal?: AbortSignal
}

const defaultScheduler: PlanSourceScheduler = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    return () => clearTimeout(handle)
  },
}

const domainReloaders: Record<PlanDomain, (ctx: PlanSourceContext) => Promise<void>> = {
  agents: (ctx) => ctx.agent.reload(),
  tools: (ctx) => ctx.tool.reload(),
  mcp: (ctx) => ctx.mcp.reload(),
  commands: (ctx) => ctx.command.reload(),
  provider: (ctx) => ctx.provider.reload(),
  model: (ctx) => ctx.model.reload(),
}

function changedDomains(previous: RegistrationPlan, next: RegistrationPlan): readonly PlanDomain[] {
  const changed: PlanDomain[] = []
  if (!jsonDeepEqual(previous.agents, next.agents) || !jsonDeepEqual(previous.defaultAgent, next.defaultAgent)) {
    changed.push("agents")
  }
  if (!jsonDeepEqual(previous.tools, next.tools)) changed.push("tools")
  if (!jsonDeepEqual(previous.mcp, next.mcp)) changed.push("mcp")
  if (!jsonDeepEqual(previous.commands, next.commands)) changed.push("commands")
  if (!jsonDeepEqual(previous.provider, next.provider)) changed.push("provider")
  if (!jsonDeepEqual(previous.model, next.model)) changed.push("model")
  return changed
}

export async function createPlanSource(
  ctx: PlanSourceContext,
  engine: PlanSourceEngine,
  options: CreatePlanSourceOptions = {},
): Promise<PlanSource> {
  const snapshot = options.snapshot ?? createHostStateSnapshot(ctx)
  const steps = createPlanStepRegistry()
  const scheduler = options.scheduler ?? defaultScheduler
  const debounceMs = options.debounceMs ?? DEFAULT_PLAN_DEBOUNCE_MS
  let lastApplied: RegistrationPlan | undefined
  let currentPlan: RegistrationPlan | undefined
  let cancelDebounce: (() => void) | undefined
  let queueTail: Promise<void> = Promise.resolve()

  steps.register({
    id: "plan-config-pipeline",
    domain: "config",
    run: async ({ base }) => {
      if (typeof engine.config !== "function") return
      currentPlan = await computeRegistrationPlan({ base, pluginHooks: { config: engine.config } })
    },
  })

  const recomputeNow = async (): Promise<void> => {
    await snapshot.refresh()
    const base = await snapshot.get()
    for (const step of steps.steps()) {
      await step.run({ ctx, engine, snapshot, base, plan: currentPlan })
    }
    if (currentPlan === undefined) return
    const baseline = lastApplied ?? noopPlanOf(base)
    if (jsonDeepEqual(baseline, currentPlan)) {
      lastApplied = currentPlan
      return
    }
    for (const domain of changedDomains(baseline, currentPlan)) {
      await domainReloaders[domain](ctx)
    }
    lastApplied = currentPlan
  }

  const enqueue = (run: () => Promise<void>): Promise<void> => {
    const next = queueTail.then(run)
    queueTail = next.then(
      () => undefined,
      (error) => {
        log(`${LOG_MARKER}: recompute failed: ${error instanceof Error ? error.message : String(error)}`)
      },
    )
    return next
  }

  const enqueueAndForget = (run: () => Promise<void>): void => {
    void enqueue(run).catch(() => undefined)
  }

  const scheduleRecompute = (): void => {
    cancelDebounce?.()
    cancelDebounce = scheduler.setTimeout(() => {
      cancelDebounce = undefined
      enqueueAndForget(recomputeNow)
    }, debounceMs)
  }

  const listener = {
    types: [...PLAN_SOURCE_EVENT_TYPES],
    onEvent: () => scheduleRecompute(),
  }
  const subscription = subscribeV2RawEvents(ctx, [listener], { signal: options.signal })

  await enqueue(recomputeNow)

  return {
    getPlan: () => currentPlan,
    snapshot,
    registerStep: (step) => {
      steps.register(step.domain === "config" ? step : { ...step, run: guardReplayStep(step.id, step.run) })
    },
    recompute: () => enqueue(recomputeNow),
    idle: () => queueTail,
    subscription,
  }
}
