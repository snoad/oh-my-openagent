// Runtime completeness guards for the provider and model registration (task
// 28 repair). The pinned @opencode/schema 2.4.1 makes every Model.Info and
// Provider.Info field below required (the host sorts models by time.released
// and reads the rest of the required set in its pickers), so an entry that is
// missing one of them can crash the host transform and disable the plugin.
// Every entry the plugin contributes passes its predicate BEFORE it reaches
// the host editor; an invalid entry is skipped and reported through the
// LIM-21 unsupported-entry reporter instead. The predicates cover exactly the
// required schema fields; optional fields stay unchecked.

import type { Model, Provider } from "@opencode/plugin"

const MODEL_STATUSES: ReadonlySet<string> = new Set(["alpha", "beta", "deprecated", "active"])
const PROVIDER_ACTIVATIONS: ReadonlySet<string> = new Set(["auto", "enabled", "disabled"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

function hasValidCost(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((row) => {
      if (!isRecord(row)) return false
      const cache = row["cache"]
      return (
        isFiniteNumber(row["input"]) &&
        isFiniteNumber(row["output"]) &&
        isRecord(cache) &&
        isFiniteNumber(cache["read"]) &&
        isFiniteNumber(cache["write"])
      )
    })
  )
}

export function isValidModelInfo(value: unknown): value is Model.Info {
  if (!isRecord(value)) return false
  const capabilities = value["capabilities"]
  const time = value["time"]
  const limit = value["limit"]
  return (
    isString(value["id"]) &&
    isString(value["modelID"]) &&
    isString(value["providerID"]) &&
    isString(value["name"]) &&
    isRecord(capabilities) &&
    typeof capabilities["tools"] === "boolean" &&
    isStringArray(capabilities["input"]) &&
    isStringArray(capabilities["output"]) &&
    Array.isArray(value["variants"]) &&
    isRecord(time) &&
    isFiniteNumber(time["released"]) &&
    hasValidCost(value["cost"]) &&
    isString(value["status"]) &&
    MODEL_STATUSES.has(value["status"]) &&
    typeof value["enabled"] === "boolean" &&
    isRecord(limit) &&
    isInteger(limit["context"]) &&
    isInteger(limit["output"])
  )
}

export function isValidProviderInfo(value: unknown): value is Provider.Info {
  if (!isRecord(value)) return false
  return (
    isString(value["id"]) &&
    isString(value["name"]) &&
    isString(value["activation"]) &&
    PROVIDER_ACTIVATIONS.has(value["activation"]) &&
    isString(value["package"])
  )
}
