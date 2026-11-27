import type { Hooks } from "@opencode-ai/plugin"

import { log } from "../../shared"

import type { HostStateSnapshot } from "./host-state-snapshot"
import type { PlanSource } from "./plan-source"
import { guardReplayEditor } from "./replay-guard"
import { toV2ToolDefinition, v1ToolMirrorOf, type V2ToolDefinition } from "./tool-codec"

// registerToolTransform (plan task 25): registers ONE recompute step with
// domain "tool" on the task-23 plan source. The tool set is the engine's own
// ToolsRecord (engine.tool, already filtered by disabled_tools and
// experimental.max_tools at engine start). The step calls
// ctx.tool.transform(editor => ...) with the task-23 guard: the replay
// callback FIRST records the pristine editor.list() into the snapshot (before
// any edit), then replaces a same-named host tool and otherwise adds (V1
// parity: a plugin tool shadows a host tool of the same name, for example the
// hashline edit tool). After the transform the step refreshes the tool
// snippets the V1 way: engine["tool.definition"]({ toolID: name },
// { description, parameters }) for every visible tool (skipping the host-only
// name "invalid"), so toolSnippets and the todoDescriptionOverride hook match
// V1. Tool steps run BEFORE the config pipeline inside a recompute (the
// task-23 order), so agent prompts embed the final snippets. The step never
// calls ctx.tool.reload(): the plan source reloads a domain only when its
// plan section changed. The JSON Schema conversion happens at registration
// time, never inside the synchronous transform callback.

const LOG_MARKER = "[opencode-v2] tool-registration"
const STEP_ID = "v2-tool-registration"
const HOST_ONLY_TOOL_NAME = "invalid"

// The host editor item form (pinned @opencode/plugin 2.4.1 Tool.Info carries
// name/input/description/execute) and the hermetic fake editor form (recorded
// fixture: id/description/parameters) share this mirror; registration entries
// carry every field so one transform serves the real host and the fake.
type V2ToolEditorItem = {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly input?: Record<string, unknown>
  readonly parameters?: Record<string, unknown>
}

type V2ToolRegistrationEntry = {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly input: Record<string, unknown>
  readonly parameters: Record<string, unknown>
  readonly execute: V2ToolDefinition["execute"]
}

type V2MutableToolEntry = {
  id: string
  name: string
  description: string
  input: Record<string, unknown>
  parameters?: Record<string, unknown>
  execute: V2ToolDefinition["execute"]
}

type V2ToolEditor = {
  list(): readonly V2ToolEditorItem[]
  get(id: string): V2ToolEditorItem | undefined
  add(tool: V2ToolRegistrationEntry): void
  update(id: string, update: (tool: V2MutableToolEntry) => void): void
}

export type ToolRegistrationContext = {
  readonly planSource: Pick<PlanSource, "registerStep" | "recompute">
  readonly tool: {
    readonly transform: (callback: (editor: V2ToolEditor) => void) => Promise<unknown>
  }
}

export type ToolRegistrationEngine = Pick<Hooks, "tool" | "tool.definition">

type PristineToolRecord = { readonly id: string; readonly description?: string }

// The snapshot record must stay structuredCloneable: the real host editor
// items carry execute functions, so the record keeps only the plain fields.
function pristineToolRecordsOf(items: readonly V2ToolEditorItem[]): readonly PristineToolRecord[] {
  return items.map((item) => ({
    id: item.id,
    ...(item.description === undefined ? {} : { description: item.description }),
  }))
}

function registrationEntryOf(name: string, v2: V2ToolDefinition): V2ToolRegistrationEntry {
  return { id: name, name, description: v2.description, input: v2.input, parameters: v2.input, execute: v2.execute }
}

function applyToolToEditor(name: string, v2: V2ToolDefinition, editor: V2ToolEditor): void {
  if (editor.get(name) !== undefined) {
    editor.update(name, (tool) => {
      tool.name = name
      tool.description = v2.description
      tool.input = v2.input
      tool.parameters = v2.input
      tool.execute = v2.execute
    })
    return
  }
  editor.add(registrationEntryOf(name, v2))
}

async function refreshToolSnippets(
  engine: ToolRegistrationEngine,
  v2Tools: ReadonlyMap<string, V2ToolDefinition>,
): Promise<void> {
  const handler = engine["tool.definition"]
  if (handler === undefined) return
  for (const [name, v2] of v2Tools) {
    if (name === HOST_ONLY_TOOL_NAME) continue
    await handler({ toolID: name }, { description: v2.description, parameters: v2.input })
  }
}

export function registerToolTransform(
  ctx: ToolRegistrationContext,
  engine: ToolRegistrationEngine,
  snapshot: HostStateSnapshot,
): Promise<void> {
  const v2Tools = new Map<string, V2ToolDefinition>()
  for (const [name, v1] of Object.entries(engine.tool ?? {})) {
    v2Tools.set(name, toV2ToolDefinition(name, v1ToolMirrorOf(name, v1)))
  }
  ctx.planSource.registerStep({
    id: STEP_ID,
    domain: "tool",
    run: async () => {
      const startedAt = Date.now()
      await ctx.tool.transform(
        guardReplayEditor("tool-registration", (editor) => {
          snapshot.record({ domain: "tool", value: pristineToolRecordsOf(editor.list()) })
          for (const [name, v2] of v2Tools) applyToolToEditor(name, v2, editor)
          return editor
        }),
      )
      await refreshToolSnippets(engine, v2Tools)
      log(`${LOG_MARKER}: registered ${String(v2Tools.size)} plugin tools in ${String(Date.now() - startedAt)}ms`)
    },
  })
  return ctx.planSource.recompute()
}
