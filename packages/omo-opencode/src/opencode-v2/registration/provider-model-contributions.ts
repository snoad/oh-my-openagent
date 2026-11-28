// V1 plan entry -> OpenCode 2 provider and model items (task 28 of the
// opencode-v2-compat plan). Tolerant readers over the plain JSON plan.provider
// section (the final V1 provider map the config pipeline produced) and the
// builders for the host items. Every builder starts from the pinned
// @opencode/schema 2.4.1 default object (Model.Info.default /
// Provider.Info.empty field sets) and then applies the V1 overrides, so each
// contribution is a COMPLETE Model.Info / Provider.Info item: the host sorts
// models by time.released and reads cost, status, enabled, limit,
// capabilities and variants in its pickers, and providers need activation and
// package. The real SDK types come through the root type import; the effect
// string brands cross through the named helpers of provider-model-info.

import type { Model, Provider } from "@opencode/plugin"

import {
  modelIDBrand,
  moneyUSDPerMillion,
  providerIDBrand,
  type MutableModelInfo,
  type MutableProviderInfo,
} from "./provider-model-info"

type V1PlanEntry = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is V1PlanEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Shared tolerant readers of the plain JSON plan sections; the merge paths
// outside this module reuse them to write only V1-expressed fields.
export function asRecord(value: unknown): V1PlanEntry {
  return isRecord(value) ? value : {}
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

export function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const headers: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    const header = asString(entry)
    if (header !== undefined) headers[key] = header
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

// V1 model-config keys the OpenCode 2 model schema can express. The V1
// per-model provider.npm override has no counterpart; an entry carrying none
// of the expressible keys is skipped by the registration (candidate LIM-21).
const EXPRESSIBLE_MODEL_KEYS = [
  "name",
  "limit",
  "modalities",
  "tool_call",
  "temperature",
  "options",
  "headers",
] as const

export function isExpressibleModelEntry(entry: unknown): boolean {
  const record = asRecord(entry)
  return EXPRESSIBLE_MODEL_KEYS.some((key) => record[key] !== undefined)
}

// The V1 releaseDate renders as milliseconds since the epoch (finite number
// or ISO date string); entries without one keep the SDK default 0.
function releasedMsOf(target: MutableModelInfo, value: unknown): void {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN
  if (Number.isFinite(parsed)) target.time = { released: parsed }
}

// The V1 flat cost object renders as one Model.Info cost row (no tier: the
// row applies to every context size) when input and output are finite.
function costRowOf(target: MutableModelInfo, value: unknown): void {
  const cost = asRecord(value)
  const input = asNumber(cost["input"])
  const output = asNumber(cost["output"])
  if (input === undefined || output === undefined) return
  const row: MutableModelInfo["cost"][number] = {
    input: moneyUSDPerMillion(input),
    output: moneyUSDPerMillion(output),
    cache: {
      read: moneyUSDPerMillion(asNumber(cost["cache_read"]) ?? 0),
      write: moneyUSDPerMillion(asNumber(cost["cache_write"]) ?? 0),
    },
  }
  target.cost = [row]
}

// Writes the expressible V1 model-config fields onto the item; used for both
// fresh contributions (provider step) and overrides onto present models
// (model step). Limit numbers fall back to the target's current values.
export function writeModelMirrorFields(target: MutableModelInfo, entry: unknown): void {
  const record = asRecord(entry)
  const name = asString(record["name"])
  if (name !== undefined) target.name = name
  const limit = asRecord(record["limit"])
  const context = asNumber(limit["context"])
  const output = asNumber(limit["output"])
  if (context !== undefined || output !== undefined) {
    target.limit = {
      context: context ?? target.limit.context,
      output: output ?? target.limit.output,
    }
  }
  const modalities = asRecord(record["modalities"])
  const input = asStringArray(modalities["input"])
  const outputList = asStringArray(modalities["output"])
  const toolCall = asBoolean(record["tool_call"])
  const temperature = asBoolean(record["temperature"])
  if (input.length > 0 || outputList.length > 0 || toolCall !== undefined || temperature !== undefined) {
    const capabilities = { ...target.capabilities }
    if (toolCall !== undefined) capabilities.tools = toolCall
    if (input.length > 0) capabilities.input = [...input]
    if (outputList.length > 0) capabilities.output = [...outputList]
    if (temperature !== undefined) capabilities.temperature = temperature
    target.capabilities = capabilities
  }
  costRowOf(target, record["cost"])
  releasedMsOf(target, record["releaseDate"])
  const options = asRecord(record["options"])
  if (Object.keys(options).length > 0) Object.assign(target, { settings: { ...(target.settings ?? {}), ...options } })
  const headers = asStringRecord(record["headers"])
  if (headers !== undefined) target.headers = { ...(target.headers ?? {}), ...headers }
}

// The SDK default field set (Model.Info.default) with the V1 overrides.
export function buildModelMirror(providerID: string, modelID: string, entry: unknown): Model.Info {
  const mirror: MutableModelInfo = {
    id: modelIDBrand(modelID),
    modelID: modelIDBrand(modelID),
    providerID: providerIDBrand(providerID),
    name: modelID,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 200000, output: 32000 },
  }
  writeModelMirrorFields(mirror, entry)
  return mirror
}

// The SDK default field set (Provider.Info.empty) with the V1 overrides.
export function buildProviderMirror(providerID: string, entry: unknown): Provider.Info {
  const record = asRecord(entry)
  const mirror: MutableProviderInfo = {
    id: providerIDBrand(providerID),
    name: asString(record["name"]) ?? providerID,
    activation: "auto",
    package: asString(record["npm"]) ?? "",
  }
  const options = asRecord(record["options"])
  if (Object.keys(options).length > 0) Object.assign(mirror, { settings: { ...options } })
  const headers = asStringRecord(options["headers"])
  if (headers !== undefined) mirror.headers = headers
  return mirror
}

export function modelEntriesOf(providerEntry: unknown): ReadonlyArray<readonly [string, unknown]> {
  return Object.entries(asRecord(asRecord(providerEntry)["models"]))
}

export function restrictionIdsOf(providerEntry: unknown): {
  readonly whitelist: readonly string[]
  readonly blacklist: readonly string[]
} {
  const record = asRecord(providerEntry)
  return { whitelist: asStringArray(record["whitelist"]), blacklist: asStringArray(record["blacklist"]) }
}

// plan.model is the V1 "providerID/modelID" default string; the provider id
// splits at the first slash exactly like V1's parseTrustedModel.
export function defaultModelRef(
  model: string | undefined,
): { readonly providerID: string; readonly modelID: string } | undefined {
  if (model === undefined) return undefined
  const [providerID, ...modelIDParts] = model.split("/")
  const modelID = modelIDParts.join("/")
  if (providerID === undefined || providerID.length === 0 || modelID.length === 0) return undefined
  return { providerID, modelID }
}
