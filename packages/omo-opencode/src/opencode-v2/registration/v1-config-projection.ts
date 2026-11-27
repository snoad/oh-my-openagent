// V1-shaped base config the V1 config pipeline expects (task 22 of the
// opencode-v2-compat plan). Every field shape is anchored through import type
// to the V1 SDKs: Config from @opencode-ai/plugin (the object the V1 config
// hook mutates) and AgentConfig from @opencode-ai/sdk. The permission fields
// are widened with an open pattern index because the V1 runtime config carries
// arbitrary glob patterns (the SDK type only names the five built-in keys),
// while staying assignable back to the narrow SDK shapes.

import type { Config as V1Config } from "@opencode-ai/plugin"
import type { AgentConfig } from "@opencode-ai/sdk"

export type V1PermissionValue = NonNullable<NonNullable<V1Config["permission"]>["edit"]>

export type V1ScopedPermission = { [scope: string]: V1PermissionValue }

export type V1PermissionMap = NonNullable<V1Config["permission"]> & {
  [pattern: string]: V1PermissionValue | V1ScopedPermission
}

// Intersected, not Omit: the SDK AgentConfig carries a string index
// signature, so Omit would collapse every named prop into one unknown union.
export type V1AgentConfigProjection = AgentConfig & { permission: V1PermissionMap }

export type V1CommandConfig = NonNullable<V1Config["command"]>[string]

export type V1ConfigProjection = {
  agent: Record<string, V1AgentConfigProjection>
  tools: NonNullable<V1Config["tools"]>
  permission: V1PermissionMap
  mcp: NonNullable<V1Config["mcp"]>
  command: Record<string, V1CommandConfig>
  default_agent?: string
  model?: NonNullable<V1Config["model"]>
  provider: NonNullable<V1Config["provider"]>
  unmapped: readonly string[]
}

// The projection without the `unmapped` metadata list: the shape handed to
// the V1 config handler, which expects the plain V1 Config fields only.
export type V1WorkingConfig = Omit<V1ConfigProjection, "unmapped">
