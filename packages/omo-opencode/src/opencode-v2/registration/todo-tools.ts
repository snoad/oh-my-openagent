import { TODOWRITE_DESCRIPTION } from "../../hooks/todo-description-override/description"
import { log } from "../../shared"

import { guardReplayEditor } from "./replay-guard"
import type { SdkToolOptions, V2ToolDefinition } from "./tool-codec"
import { readSessionTodos, writeSessionTodos, type TodoStoreContext } from "./todo-store"

// Plugin todo tools on OpenCode 2 (plan task 29): the host provides `todowrite`
// only when the opt-in experimental.todo flag is on (the pinned schema flag
// registry lists `todo` in optInOnly, "Off by default in every build") and no
// host build provides a read tool, so when ctx.tool.list() has no `todowrite`
// the plugin registers `todowrite` and `todoread` with the V1 built-in
// contract. When the host lists `todowrite` the plugin registers NOTHING so
// the names never collide. The entries follow the task-25 registration facts:
// a complete direct-tool entry (options { codemode: false }) whose execute
// returns { content: <string> }, validated before the editor handover.

const LOG_MARKER = "[opencode-v2] todo-registration"
const TODOWRITE_NAME = "todowrite"
const TODOREAD_NAME = "todoread"

const JSON_SCHEMA_ROOT = "https://json-schema.org/draft/2020-12/schema"

// The V1 built-in todowrite argument schema, verbatim from the recorded V1
// baseline tool fixture (v1-baseline/tools.json): one required `todos` array of
// items with required content/status/priority strings.
const TODO_ITEM_SCHEMA = {
  type: "object",
  properties: {
    content: { description: "Brief description of the task", type: "string" },
    priority: { description: "Priority level of the task: high, medium, low", type: "string" },
    status: { description: "Current status of the task: pending, in_progress, completed, cancelled", type: "string" },
  },
  required: ["content", "status", "priority"],
} as const

const TODOWRITE_INPUT = {
  $schema: JSON_SCHEMA_ROOT,
  type: "object",
  properties: { todos: { description: "The updated todo list", items: TODO_ITEM_SCHEMA, type: "array" } },
  required: ["todos"],
} as const
const TODOREAD_INPUT = { $schema: JSON_SCHEMA_ROOT, type: "object", properties: {} } as const
const TODOREAD_DESCRIPTION =
  "Read the current session todo list. Returns the JSON array of todos, each with content, status (pending, in_progress, completed, cancelled), priority (high, medium, low) and id."

type TodoToolExecuteContext = TodoStoreContext & {
  readonly tool: {
    readonly list: () => Promise<ReadonlyArray<{ readonly id: string }>>
    readonly transform: (callback: (editor: TodoToolEditor) => void) => Promise<unknown>
  }
}
const DIRECT_TOOL_OPTIONS: SdkToolOptions = { codemode: false }

function parseTodoArgs(input: unknown): unknown[] {
  if (typeof input !== "object" || input === null) throw new Error(`${TODOWRITE_NAME} requires a todos array`)
  const todos = (input as Record<string, unknown>)["todos"]
  if (Array.isArray(todos)) return todos
  if (typeof todos === "string") {
    try {
      const parsed: unknown = JSON.parse(todos)
      if (Array.isArray(parsed)) return parsed
    } catch (error) {
      throw new Error(`${TODOWRITE_NAME} could not parse the todos argument: ${String(error)}`)
    }
  }
  throw new Error(`${TODOWRITE_NAME} requires a todos array`)
}

async function executeTodowrite(ctx: TodoStoreContext, input: unknown, context: { readonly sessionID: string }) {
  const stored = await writeSessionTodos(ctx, context.sessionID, parseTodoArgs(input))
  const title = `${stored.filter((todo) => todo.status !== "completed").length} todos`
  return { content: JSON.stringify(stored, null, 2), metadata: { todos: stored, title } }
}

async function executeTodoread(ctx: TodoStoreContext, context: { readonly sessionID: string }) {
  const todos = await readSessionTodos(ctx, context.sessionID)
  return { content: JSON.stringify(todos, null, 2), metadata: { todos } }
}

// The registration entry the task-25 tool registration hands to the host
// editor: the codec definition plus the id and the parameters mirror of the
// input schema (the recorded host fixtures carry the JSON Schema form under
// parameters; the real host reads input).
type TodoToolRegistrationEntry = V2ToolDefinition & {
  readonly id: string
  readonly parameters: Record<string, unknown>
}

function todoToolDefinitions(ctx: TodoStoreContext): readonly TodoToolRegistrationEntry[] {
  // The todowrite description is the todoDescriptionOverride text: registering
  // it verbatim keeps the V1 override a stable no-op on V2.
  const writeEntry: TodoToolRegistrationEntry = {
    id: TODOWRITE_NAME,
    name: TODOWRITE_NAME,
    description: TODOWRITE_DESCRIPTION,
    input: TODOWRITE_INPUT,
    parameters: TODOWRITE_INPUT,
    options: DIRECT_TOOL_OPTIONS,
    execute: (input, context) => executeTodowrite(ctx, input, context),
  }
  const readEntry: TodoToolRegistrationEntry = {
    id: TODOREAD_NAME,
    name: TODOREAD_NAME,
    description: TODOREAD_DESCRIPTION,
    input: TODOREAD_INPUT,
    parameters: TODOREAD_INPUT,
    options: DIRECT_TOOL_OPTIONS,
    execute: (_input, context) => executeTodoread(ctx, context),
  }
  return [writeEntry, readEntry]
}

// The runtime handover guard (the task-28 lesson): the entry fields whose
// values the types cannot prove are checked before the editor sees them.
function isCompleteTodoToolEntry(entry: TodoToolRegistrationEntry): boolean {
  return (
    entry.name === entry.id &&
    entry.description.length > 0 &&
    entry.options.codemode === false &&
    typeof entry.execute === "function"
  )
}

export type TodoToolEditor = {
  readonly get: (id: string) => { readonly id: string } | undefined
  readonly add: (tool: TodoToolRegistrationEntry) => void
}

// The registration needs only the step registry side of the plan source plus
// the own-tool-id registry the tool record filters against; the step run
// reads no PlanStepRunInput, so this structural subset stays satisfiable by
// the real PlanSource and by test doubles alike.
export type TodoToolPlanSource = {
  readonly registerStep: (step: {
    readonly id: string
    readonly domain: "tool"
    readonly run: (input: { readonly apply: boolean }) => void | Promise<void>
  }) => void
  readonly addOwnToolMarkers: (entries: ReadonlyArray<readonly [string, string]>) => void
}

const STEP_ID = "v2-todo-registration"

// The stand-ins follow the host-native rule: on V1 a host-native tool is in
// the tool list but NEVER recorded as a plugin tool snippet (the engine
// tool.definition handler is what records snippets, and the V1 host never
// invokes it for a native tool), so the registration adds the editor entries
// only - no engine tool.definition call, no prompt snippet line.

async function applyTodoTools(ctx: TodoToolExecuteContext): Promise<void> {
  const definitions = todoToolDefinitions(ctx).filter((entry) => isCompleteTodoToolEntry(entry))
  if (definitions.length !== 2) log(`${LOG_MARKER}: skipped an incomplete todo tool entry`)
  await ctx.tool.transform(
    guardReplayEditor("todo-registration", (editor) => {
      for (const entry of definitions) {
        if (editor.get(entry.id) !== undefined) continue
        editor.add(entry)
      }
      return editor
    }),
  )
  log(`${LOG_MARKER}: registered ${String(definitions.length)} todo tools`)
}

export function registerTodoTools(ctx: TodoToolExecuteContext, planSource: TodoToolPlanSource): void {
  // The step joins BEFORE the task-25 tool step's initial recompute so every
  // recompute applies both registrations in one complete pass. The gate
  // decision is evaluated once against ctx.tool.list() (the host list at
  // registration time); after the plugin registered its own todowrite the
  // list can no longer distinguish host from plugin entries. Like every
  // plan step it writes only while the plan moves (apply), because the host
  // hands a settled recompute's transform the live editor and re-adding the
  // entries would register a fresh transform callback per pass.
  let decided = false
  planSource.registerStep({
    id: STEP_ID,
    domain: "tool",
    run: async (input) => {
      if (input.apply !== true) return
      if (!decided) {
        const hosted = await ctx.tool.list()
        decided = true
        if (hosted.some((tool) => tool.id === TODOWRITE_NAME)) {
          log(`${LOG_MARKER}: host provides ${TODOWRITE_NAME}, the plugin registers no todo tool`)
          return
        }
      }
      planSource.addOwnToolMarkers([
        [TODOWRITE_NAME, TODOWRITE_DESCRIPTION],
        [TODOREAD_NAME, TODOREAD_DESCRIPTION],
      ])
      await applyTodoTools(ctx)
    },
  })
}
