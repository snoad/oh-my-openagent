import type { DuplicateOmoPluginResult, ExternalSkillPluginResult } from "../../shared/external-plugin-detector"

// Plugin identity resolution over the OpenCode 2 plugin list (plan task 13).
// The V1 detectors read the opencode.json plugin entries from disk; OpenCode 2
// already resolved them, so the V2 detectors answer from ctx.plugin.list().
// A duplicate means more than one listed plugin source resolving to
// oh-my-openagent or oh-my-opencode; the external skill plugin check keeps the
// V1 name list and result shapes so the engine's warnings stay identical.

export type V2ListedPlugin = {
  readonly id?: string
  readonly source:
    | { readonly type: "builtin" }
    | { readonly type: "package"; readonly target: string }
    | { readonly type: "local"; readonly path: string }
    | { readonly type: "sdk" }
}

const OMO_PLUGIN_PACKAGES = [
  "oh-my-opencode",
  "oh-my-openagent",
  "@code-yeongyu/oh-my-opencode",
  "@code-yeongyu/oh-my-openagent",
]
const OMO_PLUGIN_IDS = new Set(["oh-my-opencode", "oh-my-openagent"])
const KNOWN_SKILL_PLUGINS = ["opencode-skills", "@opencode/skills"]

function normalizePackageTarget(target: string): string {
  const withoutRegistry = target.startsWith("npm:") ? target.slice("npm:".length) : target
  const versionSeparator = withoutRegistry.indexOf("@", 1)
  return versionSeparator === -1 ? withoutRegistry : withoutRegistry.slice(0, versionSeparator)
}

function pluginSourceLabel(plugin: V2ListedPlugin): string {
  if (plugin.source.type === "package") return plugin.source.target
  if (plugin.source.type === "local") return plugin.source.path
  return plugin.id ?? plugin.source.type
}

function omoPluginLabel(plugin: V2ListedPlugin): string | null {
  if (plugin.id !== undefined && OMO_PLUGIN_IDS.has(plugin.id)) return plugin.id
  if (plugin.source.type === "package") {
    const normalized = normalizePackageTarget(plugin.source.target)
    return OMO_PLUGIN_PACKAGES.includes(normalized) ? normalized : null
  }
  if (plugin.source.type === "local") {
    const segments = plugin.source.path
      .toLowerCase()
      .replaceAll("\\", "/")
      .split("/")
      .filter((segment) => segment.length > 0)
    const last = segments.at(-1)
    return last !== undefined && OMO_PLUGIN_PACKAGES.includes(last) ? last : null
  }
  return null
}

function skillPluginName(plugin: V2ListedPlugin): string | null {
  if (plugin.source.type !== "package") return null
  const normalized = normalizePackageTarget(plugin.source.target)
  return KNOWN_SKILL_PLUGINS.includes(normalized) ? normalized : null
}

export function createV2PluginDetectors(list: readonly V2ListedPlugin[]): {
  readonly detectDuplicateOmoPlugin: (directory: string) => DuplicateOmoPluginResult
  readonly detectExternalSkillPlugin: (directory: string) => ExternalSkillPluginResult
} {
  const allPlugins = list.map(pluginSourceLabel)
  const duplicatePlugins = list.flatMap((plugin) => {
    const label = omoPluginLabel(plugin)
    return label === null ? [] : [label]
  })
  // The directory parameter keeps the V1 signature; the detectors answer from
  // the plugin list of the location the runtime was started for, so it is
  // intentionally unused here.
  return {
    detectDuplicateOmoPlugin: (_directory: string): DuplicateOmoPluginResult => ({
      detected: duplicatePlugins.length > 1,
      pluginName: duplicatePlugins.length > 1 ? "oh-my-openagent" : null,
      duplicatePlugins,
      allPlugins,
    }),
    detectExternalSkillPlugin: (_directory: string): ExternalSkillPluginResult => {
      for (const plugin of list) {
        const match = skillPluginName(plugin)
        if (match !== null) return { detected: true, pluginName: match, allPlugins }
      }
      return { detected: false, pluginName: null, allPlugins }
    },
  }
}
