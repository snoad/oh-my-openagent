// V2 permission rules -> V1 tools/permission maps (task 22 of the
// opencode-v2-compat plan). V2 addresses permissions as an ordered ruleset of
// {action, resource, effect}; V1 expresses them as a tools map (name: boolean)
// plus a permission map (pattern -> action or scope -> action). The
// correspondence: V2 shell covers V1 bash, V2 subagent covers V1 task, V2 edit
// covers V1 write and V1 patch; webfetch and external_directory exist under the
// same name in the V1 permission schema, and the dotted actions mcp.use,
// skill.use and plugin.use pass through under the same name. Any other action
// (including the V2 "*" wildcard) has no V1 counterpart: it is returned in the
// explicit unmapped list and reported through onUnmapped exactly once, never
// dropped.

import type { SnapshotPermissionRule } from "./snapshot-inputs"
import type { V1PermissionMap, V1PermissionValue, V1ScopedPermission } from "./v1-config-projection"

const V1_PERMISSION_KEYS: Record<string, readonly string[]> = {
  shell: ["bash"],
  subagent: ["task"],
  edit: ["write", "patch"],
  webfetch: ["webfetch"],
  external_directory: ["external_directory"],
  "mcp.use": ["mcp.use"],
  "skill.use": ["skill.use"],
  "plugin.use": ["plugin.use"],
}

type RuleEntry = { resource: string; effect: V1PermissionValue }

export type MappedPermissionRules = {
  tools: Record<string, boolean>
  permission: V1PermissionMap
  unmapped: readonly string[]
}

// First match wins per V1 key, mirroring the ordered top-down evaluation of
// the V2 ruleset; a resource already recorded for the key keeps its effect.
export function permissionRulesToV1(
  rules: ReadonlyArray<SnapshotPermissionRule>,
  onUnmapped?: (action: string) => void,
): MappedPermissionRules {
  const seenActions = new Set<string>()
  const buckets = new Map<string, RuleEntry[]>()
  for (const rule of rules) {
    const keys = V1_PERMISSION_KEYS[rule.action]
    if (keys === undefined) {
      if (!seenActions.has(rule.action)) {
        seenActions.add(rule.action)
        onUnmapped?.(rule.action)
      }
      continue
    }
    for (const key of keys) {
      const entries = buckets.get(key) ?? []
      if (!entries.some((entry) => entry.resource === rule.resource)) {
        entries.push({ resource: rule.resource, effect: rule.effect })
      }
      buckets.set(key, entries)
    }
  }

  const tools: Record<string, boolean> = {}
  const permission: V1PermissionMap = {}
  for (const [key, entries] of buckets) {
    const wildcard = entries.find((entry) => entry.resource === "*")
    if (wildcard !== undefined) tools[key] = wildcard.effect !== "deny"
    permission[key] = renderPermissionValue(entries)
  }
  return { tools, permission, unmapped: [...seenActions] }
}

// A single "*" rule renders as the flat V1 value; any scoped rule renders as
// the scope map (the V1 bash shape), with a coexisting "*" rule as its "*"
// scope so no rule is lost.
function renderPermissionValue(entries: ReadonlyArray<RuleEntry>): V1PermissionValue | V1ScopedPermission {
  if (entries.length === 1 && entries[0] !== undefined && entries[0].resource === "*") {
    return entries[0].effect
  }
  return Object.fromEntries(entries.map((entry) => [entry.resource, entry.effect]))
}
