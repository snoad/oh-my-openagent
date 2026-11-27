// The graceful checks of the confirmed wave-3 ledger limits (opencode-v2-compat
// plan, definition-of-done item 8): each confirmed limit carries a check that
// passes against the real registration modules. LIM-15 drives the real
// permission projection (permissionRulesOfV1Agent plus the permissionStep
// reporter) with one unmappable glob rule and one mappable rule; LIM-21 drives
// the real provider contribution applier with a V1 model entry that carries
// none of the expressible fields plus an expressible sibling. v2-limits.ts
// holds the ledger entries and cites this module's checks.

import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"

import { permissionRulesOfV1Agent, permissionStep } from "../registration/permissions"
import type {
  ProviderRegistrationEditor,
  RegisteredModelInfo,
  RegisteredProviderInfo,
} from "../registration/provider-model"
import { applyProviderContributions } from "../registration/provider-model-apply"
import { isExpressibleModelEntry } from "../registration/provider-model-contributions"
import { isValidModelInfo } from "../registration/provider-model-validate"
import { EMPTY_PLAN, type PlanAgentConfig, type RegistrationPlan } from "../registration/registration-plan"

// The apiEvidence paths resolve from the pinned @opencode/plugin dist through
// the plugin package's own dependency tree, so the declaration files travel
// with the pinned plugin install.
function schemaDeclarationPath(name: string): string {
  const packageJsonPath = createRequire(import.meta.url).resolve("@opencode/plugin/package.json")
  return join(packageJsonPath, "..", "..", "schema", "dist", `${name}.d.ts`)
}

export async function lim15PermissionProjectionCheck(): Promise<void> {
  // given
  const reported: string[] = []
  const step = permissionStep({ onUnmapped: (pattern) => reported.push(pattern) })
  const entry: PlanAgentConfig = { tools: { glob: true, "task_*": false } }
  const plan: RegistrationPlan = { ...EMPTY_PLAN, tools: { "task_*": false } }

  // when
  const { rules, unmapped } = permissionRulesOfV1Agent(entry, {})
  await step.run({ plan } as Parameters<typeof step.run>[0])
  await step.run({ plan } as Parameters<typeof step.run>[0])

  // then
  const declaration = readFileSync(schemaDeclarationPath("agent"), "utf8")
  if (!declaration.includes("readonly permissions: Schema.$Array<Schema.Struct<")) {
    throw new Error("LIM-15: the cited Agent.Info permissions declaration moved")
  }
  if (!declaration.includes("readonly action: Schema.String")) {
    throw new Error("LIM-15: the permission action is no longer a plain string rule")
  }
  if (unmapped.length !== 1 || unmapped[0] !== "task_*") {
    throw new Error("LIM-15: the unmappable glob rule is not collected exactly once")
  }
  if (!rules.some((rule) => rule.action === "glob" && rule.effect === "allow")) {
    throw new Error("LIM-15: the mappable rule no longer lands")
  }
  if (rules.some((rule) => rule.action === "task_*")) {
    throw new Error("LIM-15: the unmappable pattern was written as a rule")
  }
  if (reported.length !== 1 || reported[0] !== "task_*") {
    throw new Error("LIM-15: the reporter did not fire exactly once across two runs")
  }
}

type RecordedProvider = { provider: RegisteredProviderInfo; models: Map<string, RegisteredModelInfo> }

export function lim21UnsupportedEntryCheck(): void {
  // given
  const reported: string[] = []
  const records: RecordedProvider[] = []
  const findRecord = (providerID: string): RecordedProvider | undefined =>
    records.find((record) => record.provider.id === providerID)
  const modelMapOf = (models: readonly RegisteredModelInfo[]): Map<string, RegisteredModelInfo> =>
    new Map(models.map((model): [string, RegisteredModelInfo] => [model.modelID, model]))
  const editor: ProviderRegistrationEditor = {
    list: () => records,
    get: (providerID) => findRecord(providerID),
    add: ({ info, models }) => {
      records.push({ provider: info, models: modelMapOf(models) })
    },
    update: (providerID, update) => {
      const record = findRecord(providerID)
      if (record !== undefined) update(record.provider)
    },
    models: {
      set: (providerID, models) => {
        const record = findRecord(providerID)
        if (record !== undefined) record.models = modelMapOf(models)
      },
      update: (providerID, modelID, update) => {
        const model = findRecord(providerID)?.models.get(modelID)
        if (model !== undefined) update(model)
      },
      remove: (providerID, modelID) => {
        findRecord(providerID)?.models.delete(modelID)
      },
    },
  }
  const section = {
    opengateway: {
      models: {
        "cost-only-model": { cost: { input: 1, output: 2 } },
        sibling: { name: "Sibling" },
      },
    },
  }

  // when
  applyProviderContributions(editor, section, (entry) => reported.push(entry))

  // then
  const declaration = readFileSync(schemaDeclarationPath("model"), "utf8")
  if (!declaration.includes("readonly time: Schema.Struct<")) {
    throw new Error("LIM-21: the cited Model.Info required fields moved")
  }
  if (isExpressibleModelEntry(section.opengateway.models["cost-only-model"])) {
    throw new Error("LIM-21: the premise entry grew an expressible field")
  }
  if (reported.length !== 1 || reported[0] !== "opengateway/cost-only-model") {
    throw new Error("LIM-21: the unsupported entry is not skipped and reported exactly once")
  }
  const record = records[0]
  if (record === undefined || record.provider.id !== "opengateway") {
    throw new Error("LIM-21: the expressible sibling's provider did not register")
  }
  if (record.models.has("cost-only-model")) {
    throw new Error("LIM-21: the unsupported entry reached the host editor")
  }
  const sibling = record.models.get("sibling")
  if (sibling === undefined) throw new Error("LIM-21: the expressible sibling did not register")
  if (!isValidModelInfo(sibling)) throw new Error("LIM-21: the registered sibling is not a complete Model.Info")
}
