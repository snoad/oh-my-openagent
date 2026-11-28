// Plan source (task 23): the registration recompute engine. Recomputes the
// registration plan once at start (the explicit adapter recomputes), then on
// a host config change or the provider catalog landing (model/provider
// updated, the host's registry re-resolve), plus a bounded post-startup
// continuation when a record pass caught a foreign host change.

import { log } from "../../shared"

import { subscribeV2RawEvents, type V2EventSubscription } from "../events/subscribe-v2-events"
import { armDebounceWindow, defaultPlanScheduler, drainArmedWindows, type ArmedDebounce } from "./plan-source-debounce"
import { changedPlanDomains, noopPlanOf } from "./plan-diff"
import { isRegistrationDigestEnabled, logRecomputeDigest } from "./plan-digest"
import { createPlanStepRegistry, type PlanStepDomain, type PlanStepRegistry } from "./plan-steps"
import type { PlanSourceContext, PlanSourceEngine, PlanSourceScheduler } from "./plan-source-context"
import { computeRegistrationPlan } from "./project-config"
import { type PlanDomain, type RegistrationPlan } from "./registration-plan"
import { guardReplayStep } from "./replay-guard"
import { createHostStateSnapshot, type HostStateSnapshot } from "./host-state-snapshot"

// Subscribed events: config.updated (a real host config change) plus
// model.updated and provider.updated (the host's provider catalog landing).
// agent.updated and command.updated are write echoes that would cascade;
// tool.updated and mcp.updated do not exist in 2.4.1.
export const PLAN_SOURCE_EVENT_TYPES = ["config.updated", "model.updated", "provider.updated"] as const

export const DEFAULT_PLAN_DEBOUNCE_MS = 500

// Startup chains settle within a handful of debounced recomputes.
const DEFAULT_SETTLE_MAX_ROUNDS = 16

const LOG_MARKER = "[opencode-v2] plan-source"

export type PlanSource = {
  readonly getPlan: () => RegistrationPlan | undefined
  readonly snapshot: HostStateSnapshot
  readonly registerStep: PlanStepRegistry["register"]
  // id -> the registered tool description; the record drops an item only on BOTH matching.
  readonly addOwnToolMarkers: (entries: ReadonlyArray<readonly [string, string]>) => void
  readonly ownToolMarkers: ReadonlyMap<string, string>
  readonly recompute: () => Promise<void>
  /** Arms one debounced recompute (the post-init tool-restore pass). */
  readonly scheduleRecompute: () => void
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
  readonly directory?: string
}

const domainReloaders: Record<PlanDomain, (ctx: PlanSourceContext) => Promise<void>> = {
  agents: (ctx) => ctx.agent.reload(),
  tools: (ctx) => ctx.tool.reload(),
  mcp: (ctx) => ctx.mcp.reload(),
  commands: (ctx) => ctx.command.reload(),
  provider: (ctx) => ctx.provider.reload(),
  model: (ctx) => ctx.model.reload(),
}

// The plan domains a step registration must force-reload exactly once: the
// host applies a registered editor transform only when its domain reloads
// (live row L-04). config and permission have no host editor to reload.
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
  const directory = options.directory
  let lastApplied: RegistrationPlan | undefined
  let currentPlan: RegistrationPlan | undefined
  let armed: ArmedDebounce | undefined
  let queueTail: Promise<void> = Promise.resolve()
  let startupDrained = false
  const pendingReloads = new Set<PlanDomain>()
  const ownToolMarkers = new Map<string, string>()

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
    // Every step records its pristine base on every recompute (that read
    // detects a foreign host change) but writes only while the plan moves:
    // re-applying a settled plan would mutate the registries again forever.
    let applying = pendingReloads.size > 0
    for (const step of steps.steps()) {
      await step.run({ ctx, engine, snapshot, base, plan: currentPlan, apply: applying })
      if (step.domain === "config" && currentPlan !== undefined) {
        const baseline = lastApplied ?? noopPlanOf(base)
        applying = applying || changedPlanDomains(baseline, currentPlan).length > 0
      }
    }
    // Past the startup settle boundary a record pass that caught a foreign
    // host change arms one continuation; a steady host never continues.
    if (currentPlan === undefined) {
      snapshot.consumeRecordChanges()
      return
    }
    const baseline = lastApplied ?? noopPlanOf(base)
    const changed = changedPlanDomains(baseline, currentPlan)
    const reloaded = applying || changed.length > 0
    const reloadDomains = new Set<PlanDomain>([...changed, ...pendingReloads])
    if (reloaded) {
      pendingReloads.clear()
      for (const domain of reloadDomains) {
        await domainReloaders[domain](ctx)
      }
    }
    lastApplied = currentPlan
    if (isRegistrationDigestEnabled()) {
      logRecomputeDigest({ directory: directory ?? "", plan: currentPlan, base, changed, reloadDomains })
    }
    const recordChanged = snapshot.consumeRecordChanges()
    if (startupDrained && recordChanged) scheduleRecompute()
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
  const armedOf = (): ArmedDebounce | undefined => armed
  const queueTailOf = (): Promise<void> => queueTail
  const settle = async (): Promise<void> => {
    await drainArmedWindows(armedOf, queueTailOf, settleMaxRounds)
    startupDrained = true
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
    addOwnToolMarkers: (entries) => {
      for (const [id, description] of entries) ownToolMarkers.set(id, description)
    },
    ownToolMarkers,
    registerStep: (step) => {
      steps.register(step.domain === "config" ? step : { ...step, run: guardReplayStep(step.id, step.run) })
      for (const domain of STEP_DOMAIN_RELOAD_TARGETS[step.domain]) pendingReloads.add(domain)
    },
    recompute: () => enqueue(recomputeNow),
    scheduleRecompute,
    settle,
    idle: () => queueTail,
    subscription,
  }
}
