// QA-only per-recompute digest for the registration plan source. OFF by
// default: enabled only when OMO_QA_REGISTRATION_DIGEST=1. One bounded line
// per recompute lands in the plugin log naming every plan section's
// added/modified/removed keys, a 4-hex content digest per section and the
// recorded base sizes per domain. A live-host capture reads these lines to
// show exactly which sections flip between consecutive recomputes (the
// wave-3 reload-loop investigation); the switch is never set in production.

import { log } from "../../shared"

import type { PlanDomain, PlanSection, RegistrationPlan } from "./registration-plan"
import type { V1ConfigProjection } from "./v1-config-projection"

const LOG_MARKER = "[opencode-v2] plan-digest"
const MAX_KEYS = 6

export function isRegistrationDigestEnabled(): boolean {
  return process.env.OMO_QA_REGISTRATION_DIGEST === "1"
}

function digestOf(value: unknown): string {
  const json = JSON.stringify(value) ?? ""
  let hash = 0x811c9dc5
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).slice(-4)
}

function keysBounded(keys: readonly string[]): string {
  const head = keys.slice(0, MAX_KEYS).join(",")
  const rest = keys.length - Math.min(keys.length, MAX_KEYS)
  return rest > 0 ? `${head}+${String(rest)}` : head
}

function sectionDigest(label: string, section: PlanSection<unknown>): string {
  const added = Object.keys(section.added)
  const modified = Object.keys(section.modified)
  const content = `+${String(added.length)}[${keysBounded(added)}] ~${String(modified.length)}[${keysBounded(modified)}] -${String(section.removed.length)} H${digestOf(section)}`
  return `${label} ${content}`
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function modelCountOf(entry: unknown): number {
  return Object.keys(asRecord(asRecord(entry)["models"])).length
}

function baseSummary(base: V1ConfigProjection): string {
  const providerModels = Object.values(base.provider).reduce<number>((sum, entry) => sum + modelCountOf(entry), 0)
  return `a${String(Object.keys(base.agent).length)} t${String(Object.keys(base.tools).length)} m${String(Object.keys(base.mcp).length)} c${String(Object.keys(base.command).length)} p${String(Object.keys(base.provider).length)}(${String(providerModels)}m) Mo=${base.model ?? "-"}`
}

export type RecomputeDigestInput = {
  readonly directory: string
  readonly plan: RegistrationPlan
  readonly base: V1ConfigProjection
  readonly changed: readonly PlanDomain[]
  readonly reloadDomains: ReadonlySet<PlanDomain>
}

// One line per recompute: which sections moved, their digests, and the base
// sizes the recompute diffed against.
export function logRecomputeDigest(input: RecomputeDigestInput): void {
  const dir = input.directory.split("/").filter(Boolean).pop() ?? input.directory
  const plan = input.plan
  const providerModels = Object.values(plan.provider).reduce<number>((sum, entry) => sum + modelCountOf(entry), 0)
  const parts = [
    `dir=${dir}`,
    `changed=${input.changed.length > 0 ? input.changed.join(",") : "none"}`,
    `reload=${input.reloadDomains.size > 0 ? [...input.reloadDomains].join(",") : "none"}`,
    `A d=${plan.defaultAgent ?? "-"} ${sectionDigest("", plan.agents).trimStart()}`,
    `T n=${String(Object.keys(plan.tools).length)} H${digestOf(plan.tools)}`,
    sectionDigest("M", plan.mcp),
    sectionDigest("C", plan.commands),
    `P p${String(Object.keys(plan.provider).length)} m${String(providerModels)} H${digestOf(plan.provider)}`,
    `Mo ${plan.model ?? "-"} H${digestOf(plan.model)}`,
    `BASE ${baseSummary(input.base)}`,
  ]
  log(`${LOG_MARKER} ${parts.join(" | ")}`)
}
