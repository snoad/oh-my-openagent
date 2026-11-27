import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"

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
    status: "confirmed",
    is: ["IS-8", "IS-13"],
    reason: "todos live in plugin session metadata, so host todo surfaces do not show them (task 29)",
    apiEvidence: "promise/session.d.ts#L214",
    gracefulCheck: () => {
      const resolve = createRequire(import.meta.url).resolve("@opencode/plugin/package.json")
      const declaration = readFileSync(join(resolve, "..", "dist", "promise", "session.d.ts"), "utf8")
      if (!declaration.includes('Pick<SessionApi, "list" | "create" | "get"')) throw new Error("LIM-11: evidence moved")
      const domainHead = declaration.slice(0, declaration.indexOf("export type SessionDomain"))
      if (domainHead.includes("todo")) throw new Error("LIM-11: the session API grew a todo accessor")
    },
  },
  {
    id: "LIM-12",
    status: "candidate",
    is: ["IS-4", "IS-13"],
    reason: "compaction context injection when the compaction hook cannot carry the captured context",
  },
  {
    id: "LIM-13",
    status: "confirmed",
    is: ["IS-2", "IS-13"],
    reason:
      "agent list order: the host lists agents in insertion order (default agent first, then the pre-existing host agents, plugin registrations interleaved by editor update re-insertion), so GET /api/agent order never equals the V1 baseline order; the L-03 order assertion holds the reduced guarantee (default agent leads, omo ids in canonical order, host ids keep their before-capture relative order) instead (live evidence 20261127 task-28/live: captured order sisyphus,build,general,explore,compaction,title,summary,plan,hephaestus,prometheus,atlas,librarian,metis,momus,multimodal-looker,oracle,sisyphus-junior). apiEvidence: promise/agent.d.ts L5-L11 declares the AgentEditor surface list/get/default/update/remove only; update on a missing id inserts at the end and there is no reorder or insert-at operation, so a registration cannot impose the V1 list order without removing and re-adding host agents (evidence attached by task 24)",
    apiEvidence: "promise/agent.d.ts#L5-L11",
    gracefulCheck: () => {
      if (!existsSync(`${import.meta.dir}/fixtures/v1-baseline/agents.json`)) {
        throw new Error("LIM-13: the reduced order guarantee is defined against the v1-baseline agents fixture")
      }
    },
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
    reason: "V1 glob tool rules: literal action strings have no pattern match; the context hook hides them (task 27)",
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
    id: "LIM-22",
    status: "confirmed",
    is: ["IS-4", "IS-13"],
    reason:
      "the OpenCode 2 host reserves the tool NAME edit: a plugin tool named edit is accepted into the editor but never listed in the model request and execution answers 'No tool named \"edit\" is currently available' (offline probe plugin 20261127: the same union/null-heavy args schema under another name registers, lists and executes, so the schema is not the factor). Live-only reservation: the hermetic H-REG edit-family rows keep proving the codec and the transform against the fixture-backed fake ctx. The plugin keeps the V1 name (it does not rename the tool and does not shadow patch); live row L-04 reports edit as covered by this limit",
    apiEvidence: "promise/tool.d.ts#L28-L50",
    gracefulCheck: () => {
      if (!existsSync(`${import.meta.dir}/fixtures/v1-baseline/tools.json`)) {
        throw new Error("LIM-22: the covered edit entry is defined against the v1-baseline tools fixture")
      }
    },
  },
  {
    id: "LIM-23",
    status: "confirmed",
    is: ["IS-5", "IS-13"],
    reason:
      "the system bytes of the hidden host built-ins compaction, summary and title are host-owned: the plugin preserves them (the name_only replay path never writes system), so the live prompts carry the 2.4.1 host's own bytes while the V1 baseline carries the V1 host's own bytes. Captured 20261127 (before+after, task-24-25/live L-03.txt): 6 diff lines, exactly those agents' system bytes; every agent whose prompt the pipeline produces matches the regenerated baseline byte-for-byte minus the per-process model-core ref. Live row L-03 names this limit for each native hidden row instead of printing the diff",
    apiEvidence: "promise/agent.d.ts#L12-L16",
    gracefulCheck: () => {
      const prompts = `${import.meta.dir}/fixtures/v1-baseline/agent-prompts.json`
      if (!existsSync(prompts)) throw new Error("LIM-23: the captured host prompt bytes are missing")
      const captured = JSON.parse(readFileSync(prompts, "utf8")) as Record<string, unknown>
      for (const id of ["compaction", "summary", "title"]) {
        if (typeof captured[id] !== "string") throw new Error(`LIM-23: no captured host bytes for ${id}`)
      }
    },
  },
  {
    id: "VL-1",
    status: "candidate",
    is: ["IS-14", "IS-13"],
    reason: "live OpenCode 2 parity is automated on Linux only",
  },
]
