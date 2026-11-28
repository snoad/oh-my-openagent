// Host state snapshot as the V1 base config (task 22 of the
// opencode-v2-compat plan). The projection is built from the PRISTINE
// pre-transform host state: on OpenCode 2 a domain read reflects every
// registration applied so far, including this plugin's own transforms, so a
// base read taken after the first registration would poison every later diff.
// Each domain transform of tasks 24 to 28 therefore hands the snapshot the
// value it saw at replay time BEFORE its own edits through record(), and
// get()/refresh() fall back to the ctx domain reads only for domains whose
// value was never recorded (first start). A recorded value is never re-read
// from the ctx. record() clones the handed value, so later editor mutations
// cannot leak into the base. The result is cached; refresh() rebuilds it.

import { log } from "../../shared"

import { jsonDeepEqual } from "./plan-diff"
import { mapAgentToV1Config } from "./agent-mapping"
import { mapCommandToV1, mapMcpListEntries, mapMcpServerConfig } from "./mcp-command-mapping"
import { permissionRulesToV1 } from "./permission-rules"
import {
  defaultModelToString,
  mergeModelsIntoProviders,
  providerListToV1,
  providerRecordsToV1,
} from "./provider-model-mapping"
import type {
  AgentSnapshotValue,
  ModelSnapshotValue,
  ProviderSnapshotValue,
  SnapshotContext,
  SnapshotDomain,
  SnapshotRecordValue,
  SnapshotToolRecord,
} from "./snapshot-inputs"
import type { V1ConfigProjection } from "./v1-config-projection"

export type HostStateSnapshot = {
  get(): Promise<V1ConfigProjection>
  refresh(): Promise<void>
  record(value: SnapshotRecordValue): void
  // True when at least one record() since the last consume stored a value
  // that deep-differs from that domain's previous record: the plan source's
  // bounded continuation signal (the recorded base moved, so the next
  // recompute must reconcile the plan against it).
  consumeRecordChanges(): boolean
}

export type HostStateSnapshotOptions = {
  readonly log?: (message: string, detail?: unknown) => void
}

const LOG_MARKER = "[opencode-v2] snapshot"
type V1McpMap = V1ConfigProjection["mcp"]

export function createHostStateSnapshot(ctx: SnapshotContext, options?: HostStateSnapshotOptions): HostStateSnapshot {
  const report = options?.log ?? log
  const recorded = new Map<SnapshotDomain, SnapshotRecordValue>()
  const changedRecordDomains = new Set<SnapshotDomain>()
  const reportedUnmapped = new Set<string>()
  let cache: V1ConfigProjection | undefined

  const reportUnmapped = (action: string): void => {
    if (reportedUnmapped.has(action)) return
    reportedUnmapped.add(action)
    report(`${LOG_MARKER}: V2 permission action '${action}' has no V1 counterpart; kept in projection.unmapped`, {
      action,
    })
  }

  const mapRecordedMcp = (entries: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]>): V1McpMap => {
    const map: V1McpMap = {}
    for (const [name, config] of entries) {
      try {
        map[name] = mapMcpServerConfig(name, config)
      } catch (error) {
        report(`${LOG_MARKER}: mcp server ${name} has no V1-representable config; kept out of the base mcp map`, {
          name,
          error,
        })
      }
    }
    return map
  }

  const readModelFallback = async (): Promise<ModelSnapshotValue> => {
    const models = (await ctx.model.list()).data
    const selected = (await ctx.model.default?.())?.data
    return {
      models,
      ...(selected === undefined || selected === null
        ? {}
        : { defaultModel: { providerID: selected.providerID, modelID: selected.modelID } }),
    }
  }

  const build = async (): Promise<V1ConfigProjection> => {
    const agentRecord = recorded.get("agent")
    const agentValue: AgentSnapshotValue | undefined = agentRecord?.domain === "agent" ? agentRecord.value : undefined
    const agents = agentValue?.agents ?? (await ctx.agent.list()).data
    const permissionRecord = recorded.get("permission")
    const rules =
      permissionRecord?.domain === "permission"
        ? permissionRecord.value
        : agents.flatMap((agent) => agent.permissions ?? [])

    const toolRecord = recorded.get("tool")
    const registeredTools: ReadonlyArray<SnapshotToolRecord> =
      toolRecord?.domain === "tool" ? toolRecord.value : await ctx.tool.list()

    const mcpRecord = recorded.get("mcp")
    const mcp =
      mcpRecord?.domain === "mcp" ? mapRecordedMcp(mcpRecord.value) : mapMcpListEntries((await ctx.mcp.list()).data)

    const commandRecord = recorded.get("command")
    const commands = commandRecord?.domain === "command" ? commandRecord.value : (await ctx.command.list()).data

    const providerRecord = recorded.get("provider")
    const providerMap =
      providerRecord?.domain === "provider"
        ? providerRecordsToV1(providerRecord.value)
        : providerListToV1((await ctx.provider.list()).data)

    const modelRecord = recorded.get("model")
    const modelState = modelRecord?.domain === "model" ? modelRecord.value : await readModelFallback()
    mergeModelsIntoProviders(providerMap, modelState.models)

    const { tools: permissionTools, permission, unmapped } = permissionRulesToV1(rules, reportUnmapped)
    const tools: Record<string, boolean> = {}
    for (const tool of registeredTools) tools[tool.id] = true
    Object.assign(tools, permissionTools)

    const command: Record<string, V1ConfigProjection["command"][string]> = {}
    for (const entry of commands) command[entry.name] = mapCommandToV1(entry)

    const model = modelState.defaultModel === undefined ? undefined : defaultModelToString(modelState.defaultModel)
    const defaultAgent = agentValue?.defaultAgent
    return {
      agent: Object.fromEntries(agents.map((agent) => [agent.id, mapAgentToV1Config(agent)])),
      tools,
      permission,
      mcp,
      command,
      ...(defaultAgent === undefined ? {} : { default_agent: defaultAgent }),
      ...(model === undefined ? {} : { model }),
      provider: providerMap,
      unmapped,
    }
  }

  return {
    async get() {
      cache ??= await build()
      return cache
    },
    async refresh() {
      cache = await build()
    },
    record(value: SnapshotRecordValue) {
      const next = structuredClone(value)
      const previous = recorded.get(value.domain)
      // A domain's FIRST record is not a change: the plan of that very
      // recompute diffed the same pre-edit state through the fallback ctx
      // read, so there is nothing to reconcile.
      if (previous !== undefined && !jsonDeepEqual(previous, next)) changedRecordDomains.add(value.domain)
      recorded.set(value.domain, next)
      cache = undefined
    },
    consumeRecordChanges() {
      const changed = changedRecordDomains.size > 0
      changedRecordDomains.clear()
      return changed
    },
  }
}
