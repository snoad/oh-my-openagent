// Command interception (plan task 16 of opencode-v2-compat). OpenCode 2 has
// no command.execute.before hook, so plugin commands arrive as plain prompt
// text through the prompt hook. matchPluginCommand recognizes the command
// names V1 dispatches on inside plugin/command-execute-before.ts:
// omo-mcp-env-grant (line 54), stop-continuation (line 66), goal (line 70)
// and ulw-execute (line 95, the hooks.ulwExecute fan-out). The
// autoSlashCommand fan-out (line 62) runs for every command but resolves
// names dynamically from the filesystem, so it has no fixed inventory and
// cannot join this list.

export const PLUGIN_COMMAND_INTERCEPTION_NAMES = [
  "omo-mcp-env-grant",
  "stop-continuation",
  "goal",
  "ulw-execute",
] as const

export type PluginCommandMatch = {
  readonly command: string
  readonly arguments: string
}

const INTERCEPTED_NAMES: ReadonlySet<string> = new Set<string>(PLUGIN_COMMAND_INTERCEPTION_NAMES)

const COMMAND_TEXT_PATTERN = /^\/(\S+)(?:\s+([\s\S]*))?$/

// Parses "/name" or "/name arguments" and returns the match only when the
// name is one of the plugin commands V1 handles in command.execute.before.
// The name is compared case-insensitively (V1 lowercases before dispatching)
// and reported lowercased; the arguments are the trimmed remainder.
export function matchPluginCommand(text: string): PluginCommandMatch | null {
  const match = COMMAND_TEXT_PATTERN.exec(text)
  if (match === null) return null
  const command = match[1]?.toLowerCase()
  if (command === undefined || !INTERCEPTED_NAMES.has(command)) return null
  return { command, arguments: match[2]?.trim() ?? "" }
}
