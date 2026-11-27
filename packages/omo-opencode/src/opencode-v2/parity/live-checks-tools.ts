import toolsBaseline from "./fixtures/v1-baseline/tools.json"
import { fail, pass, readText, textLines, type LiveCheck, type LiveCheckContext } from "./live-check-context"

// Live checks L-04, L-10 and L-16 (plan task 25). L-04 compares the plugin
// tool ids and JSON Schema inputs of a session's model request against the V1
// baseline fixtures (key-order-normalized deep equal); the 8 lsp_* names
// arrive with plan task 26, so they are reported by name and never fail the
// row (the evidence states the rule). L-10 follows the scripted grep tool
// call of scenario d and asserts the model received a string result in the
// V1 shape. L-16 asserts the sandbox omo.json disabled_tools entry removes
// look_at while the control grep stays visible, re-asserted after the host
// config change through scenario e (post phase).

type BaselineToolEntry = { readonly id: string; readonly parameters?: Record<string, unknown> }
type RequestToolEntry = {
  readonly name?: unknown
  readonly parameters?: unknown
  readonly input_schema?: unknown
}

const HOST_ONLY_BASELINE_IDS = new Set(["bash", "read", "write", "question", "todowrite", "webfetch", "invalid"])

// One entry per id, last occurrence wins: the V1 tool endpoint lists the host
// builtin first and the plugin registration second for shared ids.
function baselineTools(): readonly BaselineToolEntry[] {
  const byId = new Map<string, BaselineToolEntry>()
  for (const entry of toolsBaseline.tools as readonly BaselineToolEntry[]) byId.set(entry.id, entry)
  return [...byId.values()]
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return nested
    const record = nested as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    )
  })
}

// The disabled_tools names the sandbox omo.json removes (L-16's control
// pair): the tool parity check treats them as environment-dependent so the
// deliberate removal never fails L-04.
function disabledToolsOfManifest(manifest: { readonly sandboxOmoConfig?: string }): ReadonlySet<string> {
  const raw = manifest.sandboxOmoConfig
  if (raw === undefined) return new Set()
  try {
    const parsed = JSON.parse(readText(raw)) as { "[opencode]"?: { disabled_tools?: unknown } }
    const list = parsed["[opencode]"]?.disabled_tools
    if (!Array.isArray(list)) return new Set()
    return new Set(list.filter((name): name is string => typeof name === "string"))
  } catch {
    return new Set()
  }
}

export function requestToolsOf(requestsFile: string): ReadonlyMap<string, RequestToolEntry> {
  const byName = new Map<string, RequestToolEntry>()
  for (const line of textLines(readText(requestsFile))) {
    let body: unknown
    try {
      body = JSON.parse(line)
    } catch {
      continue
    }
    const tools = (body as { tools?: unknown }).tools
    if (!Array.isArray(tools)) continue
    for (const tool of tools) {
      if (tool === null || typeof tool !== "object") continue
      const name = (tool as { name?: unknown }).name
      if (typeof name === "string") byName.set(name, tool as RequestToolEntry)
    }
  }
  return byName
}

export const checkToolRegistrationParity: LiveCheck = async (ctx) => {
  const scenarioA = ctx.manifest.scenarios.a
  if (scenarioA === undefined) return fail("manifest carries no scenario a", "L-04 FAIL: scenario a missing.\n")
  const requestTools = requestToolsOf(scenarioA.requestsFile)
  const envDependent = new Set(
    Object.keys((toolsBaseline as { envDependent?: Record<string, unknown> }).envDependent ?? {}),
  )
  const disabledByConfig = disabledToolsOfManifest(ctx.manifest)
  const lspMissing: string[] = []
  const baselineMissing: string[] = []
  const configDisabled: string[] = []
  const schemaDrift: string[] = []
  const schemaKeySeen = [...requestTools.values()].some((tool) => tool.parameters !== undefined)
    ? "parameters"
    : "input_schema"
  for (const entry of baselineTools()) {
    if (HOST_ONLY_BASELINE_IDS.has(entry.id)) continue
    if (entry.id.startsWith("lsp_")) {
      if (!requestTools.has(entry.id)) lspMissing.push(entry.id)
      continue
    }
    const requestTool = requestTools.get(entry.id)
    if (requestTool === undefined) {
      if (envDependent.has(entry.id)) continue
      if (disabledByConfig.has(entry.id)) {
        configDisabled.push(entry.id)
        continue
      }
      baselineMissing.push(entry.id)
      continue
    }
    const requestSchema = schemaKeySeen === "parameters" ? requestTool.parameters : requestTool.input_schema
    if (stableJson(requestSchema) !== stableJson(entry.parameters)) schemaDrift.push(entry.id)
  }
  const baselineIds = new Set(toolsBaseline.tools.map((entry) => entry.id))
  const extraPluginNames = [...requestTools.keys()].filter(
    (name) => !HOST_ONLY_BASELINE_IDS.has(name) && !baselineIds.has(name) && !name.startsWith("lsp_"),
  )
  const evidence = [
    "L-04 PASS/FAIL: plugin tool ids and JSON Schema inputs equal the V1 baseline (key order normalized).",
    `request tool entries: ${String(requestTools.size)}; schema key: ${schemaKeySeen}`,
    `V1 baseline plugin tools missing from the request: ${baselineMissing.length === 0 ? "none" : baselineMissing.join(",")}`,
    `removed by the sandbox omo.json disabled_tools (reported, not failing): ${configDisabled.length === 0 ? "none" : configDisabled.join(",")}`,
    `lsp_* names not yet registered (task 26 owns them via the lsp MCP; reported, not failing): ${lspMissing.length === 0 ? "none" : lspMissing.join(",")}`,
    `JSON Schema drift: ${schemaDrift.length === 0 ? "none" : schemaDrift.join(",")}`,
    `request tools outside the baseline (V2 host builtins): ${extraPluginNames.join(",") || "none"}`,
    "host-only V1 names compared by role not by name (bash vs shell, read, write, question, todowrite, webfetch); invalid is host-internal.",
    "",
  ].join("\n")
  if (baselineMissing.length > 0) return fail(`plugin tools missing: ${baselineMissing.join(",")}`, evidence)
  if (schemaDrift.length > 0) return fail(`JSON Schema drift: ${schemaDrift.join(",")}`, evidence)
  return pass(
    `every V1 plugin tool is registered with the baseline input schema; ${String(lspMissing.length)} lsp_* names pending task 26`,
    evidence,
  )
}
