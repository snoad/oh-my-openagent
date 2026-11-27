// The real pinned OpenCode 2 SDK item types for the MCP registration (task
// 26 of the opencode-v2-compat plan). The 2.4.1 Mcp.ServerConfig is the
// tagged local|remote union of the schema types, and the host editors hand
// Types.DeepMutable items, so the registration mirrors them through
// homomorphic mutable views (the provider-model-info precedent). The pinned
// schema carries NO by-name environment binding (LocalConfig.environment is a
// literal Record<string, string>), so expanded env values land in the
// registry literally and live row L-23 measures their exposure.

import type { Mcp } from "@opencode/plugin"

export type MutableLocalConfig = { -readonly [K in keyof Mcp.LocalConfig]: Mcp.LocalConfig[K] }
export type MutableRemoteConfig = { -readonly [K in keyof Mcp.RemoteConfig]: Mcp.RemoteConfig[K] }
export type MutableServerConfig = MutableLocalConfig | MutableRemoteConfig

export type OAuthMirror = { -readonly [K in keyof Mcp.OAuthConfig]: Mcp.OAuthConfig[K] }

// The snapshot record form of one mcp editor entry: a plain name/config pair
// (structuredCloneable, never a host item reference).
export type McpSnapshotEntry = readonly [string, Readonly<Record<string, unknown>>]
