// V2 MCP server and command -> V1 shapes (task 22 of the opencode-v2-compat
// plan). A recorded MCP server config (the [name, config] pair a transform saw
// in the mcp editor) maps onto the V1 McpLocalConfig / McpRemoteConfig union.
// The mcp domain list carries only {name, status} on 2.4.1, so a fallback
// entry maps to a disabled placeholder that preserves the server's presence
// for the config diff without inventing a usable config. A V2 command is code
// (execute), not a prompt template, so the V1 command entry keeps the name and
// description with an inert empty template until task 28 registers the real
// command through the editor.

import type { McpLocalConfig, McpRemoteConfig } from "@opencode-ai/sdk"

import type { SnapshotCommandRecord, SnapshotMcpListEntry } from "./snapshot-inputs"
import type { V1CommandConfig } from "./v1-config-projection"

function localEnvOf(config: Readonly<Record<string, unknown>>): Record<string, string> | undefined {
  const environment = config.environment
  if (!isRecord(environment)) return undefined
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string") env[key] = value
  }
  return env
}

function enabledOf(config: Readonly<Record<string, unknown>>): boolean | undefined {
  return typeof config.enabled === "boolean" ? config.enabled : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function mapMcpServerConfig(
  name: string,
  config: Readonly<Record<string, unknown>>,
): McpLocalConfig | McpRemoteConfig {
  const enabled = enabledOf(config)
  if (config.type === "local" && Array.isArray(config.command)) {
    const command = config.command.filter((entry): entry is string => typeof entry === "string")
    const environment = localEnvOf(config)
    return {
      type: "local",
      command,
      ...(environment === undefined ? {} : { environment }),
      ...(enabled === undefined ? {} : { enabled }),
    }
  }
  if (config.type === "remote" && typeof config.url === "string") {
    return {
      type: "remote",
      url: config.url,
      ...(enabled === undefined ? {} : { enabled }),
    }
  }
  throw new Error(`opencode-v2 snapshot: mcp server ${name} has neither a local command nor a remote url`)
}

export function mapMcpListEntries(
  entries: ReadonlyArray<SnapshotMcpListEntry>,
): Record<string, McpLocalConfig | McpRemoteConfig> {
  return Object.fromEntries(entries.map((entry) => [entry.name, { type: "remote" as const, url: "", enabled: false }]))
}

export function mapCommandToV1(command: SnapshotCommandRecord): V1CommandConfig {
  return {
    template: "",
    ...(command.description === undefined ? {} : { description: command.description }),
  }
}
