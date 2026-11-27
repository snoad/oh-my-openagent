// V1 plan entry -> OpenCode 2 provider and model mirrors (task 28 of the
// opencode-v2-compat plan). Tolerant readers over the plain JSON plan.provider
// section (the final V1 provider map the config pipeline produced) and the
// builders for the structural editor mirrors. The pinned @opencode/schema
// 2.4.1 types carry effect brands, so the registration crosses as plain
// mirrors (the sanctioned local-structural-types branch, task-9 precedent).

type V1PlanEntry = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is V1PlanEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): V1PlanEntry {
  return isRecord(value) ? value : {}
}

function asString(value: unknown): string | undefined {
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

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const headers: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    const header = asString(entry)
    if (header !== undefined) headers[key] = header
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

// V1 model-config keys the OpenCode 2 model schema can express. V1 per-model
// cost objects (the V2 cost is a tagged per-context-size table) and the V1
// per-model provider.npm override have no counterpart; an entry carrying none
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

// Writes the expressible V1 model-config fields onto the mirror; used for both
// fresh contributions (provider step) and overrides onto present models
// (model step). Limit numbers fall back to the target's current values.
export function writeModelMirrorFields(
  target: {
    name: string
    limit?: { context: number; output: number }
    capabilities?: { tools?: boolean; input?: string[]; output?: string[] }
    temperature?: boolean
    settings?: Record<string, unknown>
    headers?: Record<string, string>
    [key: string]: unknown
  },
  entry: unknown,
): void {
  const record = asRecord(entry)
  const name = asString(record["name"])
  if (name !== undefined) target.name = name
  const limit = asRecord(record["limit"])
  const context = asNumber(limit["context"])
  const output = asNumber(limit["output"])
  if (context !== undefined || output !== undefined) {
    target.limit = {
      context: context ?? target.limit?.context ?? 0,
      output: output ?? target.limit?.output ?? 0,
    }
  }
  const modalities = asRecord(record["modalities"])
  const input = asStringArray(modalities["input"])
  const outputList = asStringArray(modalities["output"])
  const toolCall = asBoolean(record["tool_call"])
  if (input.length > 0 || outputList.length > 0 || toolCall !== undefined) {
    const capabilities = { ...(target.capabilities ?? {}) }
    if (toolCall !== undefined) capabilities.tools = toolCall
    if (input.length > 0) capabilities.input = [...input]
    if (outputList.length > 0) capabilities.output = [...outputList]
    target.capabilities = capabilities
  }
  const temperature = asBoolean(record["temperature"])
  if (temperature !== undefined) target.temperature = temperature
  const options = asRecord(record["options"])
  if (Object.keys(options).length > 0) target.settings = { ...(target.settings ?? {}), ...options }
  const headers = asStringRecord(record["headers"])
  if (headers !== undefined) target.headers = { ...(target.headers ?? {}), ...headers }
}

export type BuiltModelMirror = {
  readonly id: string
  readonly modelID: string
  readonly providerID: string
  name: string
  enabled: boolean
  limit: { context: number; output: number }
  capabilities: { tools: boolean; input: string[]; output: string[] }
  [key: string]: unknown
}

export function buildModelMirror(providerID: string, modelID: string, entry: unknown): BuiltModelMirror {
  const mirror: BuiltModelMirror = {
    id: modelID,
    modelID,
    providerID,
    name: modelID,
    enabled: true,
    limit: { context: 0, output: 0 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
  }
  writeModelMirrorFields(mirror, entry)
  return mirror
}

export type BuiltProviderMirror = {
  readonly id: string
  name: string
  package?: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  [key: string]: unknown
}

export function buildProviderMirror(providerID: string, entry: unknown): BuiltProviderMirror {
  const record = asRecord(entry)
  const mirror: BuiltProviderMirror = { id: providerID, name: asString(record["name"]) ?? providerID }
  const npm = asString(record["npm"])
  if (npm !== undefined) mirror["package"] = npm
  const options = asRecord(record["options"])
  if (Object.keys(options).length > 0) {
    mirror.settings = { ...options }
    const headers = asStringRecord(options["headers"])
    if (headers !== undefined) mirror.headers = headers
  }
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
