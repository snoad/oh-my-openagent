import type { IsRow } from "./rows"

export type V2Limit = {
  id: string
  status: "candidate" | "confirmed"
  is: IsRow[]
  reason: string
  apiEvidence?: string
  gracefulCheck?: () => void | Promise<void>
}

// LAW (opencode-v2-compat plan, task 5): a limit id NOT seeded here may never
// be added. A newly discovered gap is stop-and-report BLOCKED, not a new limit.
// Task 43 closes the ledger: each entry is removed when its wave reached parity
// or set to confirmed with apiEvidence resolvable under
// node_modules/@opencode/plugin/dist plus a passing gracefulCheck. Every limit
// maps to IS-13 (the ledger IS that owns the limit path) next to the natural
// IS of its capability.
export const V2_LIMITS: V2Limit[] = [
  {
    id: "LIM-1",
    status: "candidate",
    is: ["IS-4", "IS-13"],
    reason:
      "interception of commands the plugin does not own: command.execute.before has no one-to-one OpenCode 2 hook",
  },
  {
    id: "LIM-2",
    status: "candidate",
    is: ["IS-4", "IS-13"],
    reason: "per-call tool.definition mutation: only the tool transform exists",
  },
  {
    id: "LIM-3",
    status: "candidate",
    is: ["IS-4", "IS-13"],
    reason:
      "cross-provider model switch requested by a chat.message variant: experimental.model.resolve stays within the provider",
    apiEvidence:
      "node_modules/@opencode/plugin/dist/promise/session.d.ts SessionModelResolve: the experimental.model.resolve hook mutates model as a Model.Ref whose providerID names one provider; the host restricts the switch to that provider, so a cross-provider chat.message model request cannot cross (evidence attached by task 16)",
  },
  {
    id: "LIM-4",
    status: "candidate",
    is: ["IS-9", "IS-13"],
    reason: "TUI raw key interception and pixel-level parity: keymap layers and a different slot set",
  },
  {
    id: "LIM-5",
    status: "candidate",
    is: ["IS-8", "IS-13"],
    reason: "V1 session.summarize semantics: OpenCode 2 offers compact",
  },
  {
    id: "LIM-6",
    status: "candidate",
    is: ["IS-10", "IS-13"],
    reason: "omo run on an OpenCode 2 host",
  },
  {
    id: "LIM-7",
    status: "candidate",
    is: ["IS-5", "IS-17", "IS-13"],
    reason: "plugin config resolved per plugin instance location",
  },
  {
    id: "LIM-8",
    status: "candidate",
    is: ["IS-3", "IS-13"],
    reason: "interactive ask of question tools when the V2 tool context has no question channel",
  },
  {
    id: "LIM-9",
    status: "candidate",
    is: ["IS-4", "IS-8", "IS-13"],
    reason:
      "provider-error classification for runtime fallback: OpenCode 2 reports SessionError objects and has no session.error event",
  },
  {
    id: "LIM-11",
    status: "candidate",
    is: ["IS-8", "IS-13"],
    reason:
      "todos provided by the plugin instead of the host: experimental.todo is off by default, so host todo surfaces do not show them",
  },
  {
    id: "LIM-12",
    status: "candidate",
    is: ["IS-4", "IS-13"],
    reason: "compaction context injection when the compaction hook cannot carry the captured context",
  },
  {
    id: "LIM-13",
    status: "candidate",
    is: ["IS-2", "IS-13"],
    reason: "agent list order",
  },
  {
    id: "LIM-14",
    status: "candidate",
    is: ["IS-6", "IS-13"],
    reason: "MCP cold-start timeout on slow machines",
  },
  {
    id: "LIM-15",
    status: "candidate",
    is: ["IS-2", "IS-13"],
    reason: "permission projection rules OpenCode 2 cannot express",
  },
  {
    id: "LIM-16",
    status: "candidate",
    is: ["IS-8", "IS-13"],
    reason: "child-session parent linkage when the V2 session API has no parent field",
  },
  {
    id: "LIM-17",
    status: "candidate",
    is: ["IS-10", "IS-11", "IS-13"],
    reason: "a shared V1 plus V2 machine where a CLI install prunes the OpenCode 2 plugin cache copy",
  },
  {
    id: "LIM-18",
    status: "candidate",
    is: ["IS-4", "IS-13"],
    reason: "the auto-update-checker hook is inert on OpenCode 2 because the host owns plugin updates",
  },
  {
    id: "LIM-19",
    status: "candidate",
    is: ["IS-4", "IS-13"],
    reason: "Code Mode tool calls (codemode: true) in the tool hooks",
  },
  {
    id: "LIM-20",
    status: "candidate",
    is: ["IS-6", "IS-13"],
    reason: "expanded MCP environment values exposed through the MCP API",
  },
  {
    id: "LIM-21",
    status: "candidate",
    is: ["IS-5", "IS-13"],
    reason:
      "V1 provider model entries the OpenCode 2 model schema cannot express: the V1 per-model cost object and the per-model provider.npm override have no OpenCode 2 model-info counterpart, so catalog entries register without them and entries that carry none of the expressible fields (name, limit, modalities, tool_call, temperature, options, headers) are skipped with one log line naming the entry (task 28)",
  },
  {
    id: "VL-1",
    status: "candidate",
    is: ["IS-14", "IS-13"],
    reason: "live OpenCode 2 parity is automated on Linux only",
  },
]
