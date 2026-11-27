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
import { armDebounceWindow, defaultPlanScheduler, drainArmedWindows, type ArmedDebounce } from "./plan-source-debounce"
import { changedPlanDomains, noopPlanOf } from "./plan-diff"
import { createPlanStepRegistry, type PlanStepDomain, type PlanStepRegistry } from "./plan-steps"
import type { PlanSourceContext, PlanSourceEngine, PlanSourceScheduler } from "./plan-source-context"
import { computeRegistrationPlan } from "./project-config"
import { type PlanDomain, type RegistrationPlan } from "./registration-plan"
import { guardReplayStep } from "./replay-guard"
import { permissionRulesOfV1Agent } from "./permissions"
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

// The settle round cap: startup event chains observed on the live host
// converge within a handful of debounced recomputes; 16 leaves headroom
// without unbounding the drain against a reconnect storm.
const DEFAULT_SETTLE_MAX_ROUNDS = 16

const LOG_MARKER = "[opencode-v2] plan-source"

export type PlanSource = {
  readonly getPlan: () => RegistrationPlan | undefined
  readonly snapshot: HostStateSnapshot
  readonly registerStep: PlanStepRegistry["register"]
  readonly recompute: () => Promise<void>
  readonly settle: () => Promise<void>
  readonly idle: () => Promise<void>
  readonly subscription: V2EventSubscription
}

export type CreatePlanSourceOptions = {
  readonly snapshot?: HostStateSnapshot
  readonly scheduler?: PlanSourceScheduler
  readonly debounceMs?: number
  readonly signal?: AbortSignal
  readonly settleMaxRounds?: number
}

const domainReloaders: Record<PlanDomain, (ctx: PlanSourceContext) => Promise<void>> = {
  agents: (ctx) => ctx.agent.reload(),
  tools: (ctx) => ctx.tool.reload(),
  mcp: (ctx) => ctx.mcp.reload(),
  commands: (ctx) => ctx.command.reload(),
  provider: (ctx) => ctx.provider.reload(),
  model: (ctx) => ctx.model.reload(),
}

// The plan domains a step registration must force-reload exactly once on the
// next recompute. The host applies a registered editor transform only when its
// domain reloads (live row L-04 at HEAD a69eaf7234: the tool step logged
// "registered 14 plugin tools" with no replay failure, yet no plugin tool
// reached the session's model request, because the plan never changed after
// the registration and so no tool reload ever ran). config has no host editor
// to reload and permission rides on the agent items, so both map to nothing.
const STEP_DOMAIN_RELOAD_TARGETS: Record<PlanStepDomain, readonly PlanDomain[]> = {
  tool: ["tools"],
  config: [],
  agent: ["agents"],
  permission: [],
  mcp: ["mcp"],
  command: ["commands"],
  provider: ["provider"],
  model: ["model"],
}

export async function createPlanSource(
  ctx: PlanSourceContext,
  engine: PlanSourceEngine,
  options: CreatePlanSourceOptions = {},
): Promise<PlanSource> {
  const snapshot = options.snapshot ?? createHostStateSnapshot(ctx)
  const steps = createPlanStepRegistry()
  const scheduler = options.scheduler ?? defaultPlanScheduler
  const debounceMs = options.debounceMs ?? DEFAULT_PLAN_DEBOUNCE_MS
  const settleMaxRounds = options.settleMaxRounds ?? DEFAULT_SETTLE_MAX_ROUNDS
  let lastApplied: RegistrationPlan | undefined
  let currentPlan: RegistrationPlan | undefined
  let armed: ArmedDebounce | undefined
  let queueTail: Promise<void> = Promise.resolve()
  const pendingReloads = new Set<PlanDomain>()

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
    const changed = changedPlanDomains(baseline, currentPlan)
    if (changed.length === 0 && pendingReloads.size === 0) {
      lastApplied = currentPlan
      return
    }
    const reloadDomains = new Set<PlanDomain>([...changed, ...pendingReloads])
    pendingReloads.clear()
    for (const domain of reloadDomains) {
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
    armed?.cancel()
    armed = armDebounceWindow(scheduler, debounceMs, () => {
      armed = undefined
      enqueueAndForget(recomputeNow)
    })
  }

  const settle = (): Promise<void> =>
    drainArmedWindows(
      () => armed,
      () => queueTail,
      settleMaxRounds,
    )

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
      for (const domain of STEP_DOMAIN_RELOAD_TARGETS[step.domain]) pendingReloads.add(domain)
    },
    recompute: () => enqueue(recomputeNow),
    settle,
    idle: () => queueTail,
    subscription,
  }
}
