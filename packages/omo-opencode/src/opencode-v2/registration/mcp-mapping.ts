// The V1 -> OpenCode 2 MCP server mapping (task 26 of the opencode-v2-compat
// plan). Every V1 McpConfig variant the pipeline merge produces (builtins,
// Claude Code .mcp.json servers after the loader transform, plugin-component
// servers and user entries) maps onto the pinned Mcp.ServerConfig union:
// local keeps command (string command plus args is the tolerated CC-style
// spelling), cwd and environment (env as the alias), remote keeps url,
// headers and oauth; the V1 enabled:false flag becomes the V2 disabled flag.
// Precedence, disabled_mcps, user enabled:false and the ${VAR} allowlist are
// applied inside the V1 pipeline and are NOT re-implemented here. The
// completeness guard runs on the BUILT item before it reaches the host
// editor: an invalid entry is skipped and reported (the task-28 rule), never
// handed over half-built.

import type { Mcp } from "@opencode/plugin"

import type { McpSnapshotEntry, OAuthMirror } from "./mcp-info"
import type { PlanServerConfig } from "./registration-plan"

export type UnsupportedMcpReporter = (entry: string) => void

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringRecordOf(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const strings: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") strings[key] = entry
  }
  return Object.keys(strings).length > 0 ? strings : undefined
}

function stringArrayOf(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined
}

// The local command: a V1 string array, or the tolerated CC-style spelling
// (a single command string plus an args array).
function commandOf(entry: PlanServerConfig): readonly string[] | undefined {
  const command = entry["command"]
  if (typeof command === "string") {
    return [command, ...(stringArrayOf(entry["args"]) ?? [])]
  }
  return stringArrayOf(command)
}

// The environment record: the V1 environment key, or the tolerated CC-style
// env alias. Values are literals: the pipeline expanded every allowlisted
// ${VAR} reference, and the pinned 2.4.1 LocalConfig carries no by-name
// environment binding.
function environmentOf(entry: PlanServerConfig): Record<string, string> | undefined {
  return stringRecordOf(entry["environment"]) ?? stringRecordOf(entry["env"])
}

function oauthOf(entry: PlanServerConfig): OAuthMirror | false | undefined {
  if (entry["oauth"] === false) return false
  const record = asRecord(entry["oauth"])
  if (record === undefined) return undefined
  const mirror: OAuthMirror = {}
  const clientId = record["client_id"]
  if (typeof clientId === "string") mirror.client_id = clientId
  const clientSecret = record["client_secret"]
  if (typeof clientSecret === "string") mirror.client_secret = clientSecret
  const scope = record["scope"]
  if (typeof scope === "string") mirror.scope = scope
  const redirectUri = record["redirect_uri"]
  if (typeof redirectUri === "string") mirror.redirect_uri = redirectUri
  const metadataUrl = record["auth_server_metadata_url"]
  if (typeof metadataUrl === "string") mirror.auth_server_metadata_url = metadataUrl
  const callbackPort = record["callback_port"]
  if (typeof callbackPort === "number" && Number.isInteger(callbackPort)) mirror.callback_port = callbackPort
  return mirror
}

function toLocalConfig(entry: PlanServerConfig): Mcp.LocalConfig | undefined {
  const command = commandOf(entry)
  if (command === undefined || command.length === 0) return undefined
  const cwd = typeof entry["cwd"] === "string" ? entry["cwd"] : undefined
  const environment = environmentOf(entry)
  return {
    type: "local",
    command: [...command],
    ...(cwd === undefined ? {} : { cwd }),
    ...(environment === undefined ? {} : { environment }),
    ...(entry["enabled"] === false ? { disabled: true } : {}),
  }
}

function toRemoteConfig(entry: PlanServerConfig): Mcp.RemoteConfig | undefined {
  const url = entry["url"]
  if (typeof url !== "string" || url.length === 0) return undefined
  const headers = stringRecordOf(entry["headers"])
  const oauth = oauthOf(entry)
  return {
    type: "remote",
    url,
    ...(headers === undefined ? {} : { headers }),
    ...(oauth === undefined ? {} : { oauth }),
    ...(entry["enabled"] === false ? { disabled: true } : {}),
  }
}

// Maps one V1 pipeline entry onto the V2 union; undefined marks an entry the
// V2 union cannot express (no local command, no remote url, or an unknown
// type), which the caller skips through the reporter.
export function toV2ServerConfig(entry: PlanServerConfig): Mcp.ServerConfig | undefined {
  const type = typeof entry["type"] === "string" ? entry["type"] : undefined
  if (type === "remote") return toRemoteConfig(entry)
  if (type === "local" || type === undefined) return toLocalConfig(entry) ?? toRemoteConfig(entry)
  return undefined
}

// The completeness guard on the BUILT item before the editor handover: a
// local entry carries a non-empty string command, a remote entry a non-empty
// url.
export function isValidServerConfig(config: Mcp.ServerConfig): boolean {
  const record = config as Record<string, unknown>
  if (record["type"] === "local") {
    const command = record["command"]
    return Array.isArray(command) && command.length > 0 && command.every((entry) => typeof entry === "string")
  }
  if (record["type"] === "remote") {
    return typeof record["url"] === "string" && record["url"].length > 0
  }
  return false
}

// The pre-edit editor value as plain name/config pairs. The copies keep the
// identity and environment fields the task-22 base projection reads, so the
// snapshot record stays structuredCloneable on the real host (whose editor
// items are DeepMutable schema views) while never leaking post-record edits
// into the pristine base.
export function mcpSnapshotValueOf(editor: {
  readonly list: () => ReadonlyArray<readonly [string, unknown]>
}): McpSnapshotEntry[] {
  return editor.list().map(([name, item]) => [name, plainServerConfigOf(item)])
}

function plainServerConfigOf(item: unknown): Record<string, unknown> {
  const source = asRecord(item) ?? {}
  const plain: Record<string, unknown> = {}
  for (const field of ["type", "command", "cwd", "environment", "disabled", "url", "headers", "oauth"] as const) {
    const value = source[field]
    if (value !== undefined) plain[field] = value
  }
  return plain
}
