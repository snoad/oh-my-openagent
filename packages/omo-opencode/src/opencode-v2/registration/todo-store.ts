import type { Todo } from "@opencode-ai/sdk"
import type { JsonValue } from "@opencode/client"

// Per-session todo store on OpenCode 2 (plan task 29): OpenCode 2.4 ships no
// todo tool by default (the pinned @opencode/schema 2.4.1 flag registry marks
// `todo` optInOnly and "Off by default in every build"), so the plugin keeps
// the V1 todo contract in session metadata under the reserved key `omo.todos`
// through ctx.session.update({ sessionID, metadata }). Reads go through
// ctx.session.get. EVERY session-metadata writer in the V2 tree (tasks 30, 32
// and 34 included) must go through updateSessionMetadata: a plain
// read-modify-write loses updates when parallel tool calls hit the same
// session, so the writes serialize through one per-session mutex and the
// patch still merges without touching other metadata keys.

export const OMO_TODOS_METADATA_KEY = "omo.todos"

// The SDK session metadata record shape (client-generated JsonValue record).
export type SessionMetadataRecord = { readonly [key: string]: JsonValue }

// Structural ctx slice for the metadata write path. The real host and the
// hermetic fake both satisfy it; the static shim ctx slice omits update, so
// the registration adapter narrows the ctx once at that boundary.
export type TodoStoreContext = {
  readonly session: {
    readonly get: (input: { readonly sessionID: string }) => Promise<{ readonly metadata?: SessionMetadataRecord }>
    readonly update: (input: { readonly sessionID: string; readonly metadata?: SessionMetadataRecord }) => Promise<void>
  }
}

// The read path only needs get (the shim ctx slice satisfies it).
export type TodoReadContext = {
  readonly session: Pick<TodoStoreContext["session"], "get">
}

// The per-session mutex: one settled-promise tail per sessionID. The next
// write starts only after the previous one settled (fulfilled OR rejected), so
// a failed write never poisons later writes and concurrent calls never
// interleave their read-modify-write halves.
const sessionMetadataMutexes = new Map<string, Promise<void>>()

function settledTail(job: Promise<void>): Promise<void> {
  return job.then(
    () => undefined,
    () => undefined,
  )
}

function enqueueMetadataWrite(sessionID: string, write: () => Promise<void>): Promise<void> {
  const previous = sessionMetadataMutexes.get(sessionID) ?? Promise.resolve()
  const job = previous.then(write)
  sessionMetadataMutexes.set(sessionID, settledTail(job))
  return job
}

async function applyMetadataPatch(
  ctx: TodoStoreContext,
  sessionID: string,
  patch: SessionMetadataRecord,
): Promise<void> {
  const info = await ctx.session.get({ sessionID })
  const metadata: Record<string, JsonValue> = { ...(info.metadata ?? {}), ...patch }
  await ctx.session.update({ sessionID, metadata })
}

// The ONE sanctioned session-metadata write path for the whole V2 tree.
export function updateSessionMetadata(
  ctx: TodoStoreContext,
  sessionID: string,
  patch: SessionMetadataRecord,
): Promise<void> {
  return enqueueMetadataWrite(sessionID, () => applyMetadataPatch(ctx, sessionID, patch))
}

function todoID(sessionID: string, index: number): string {
  return `${sessionID}:${String(index)}`
}

function isTodoEntry(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// The V1 Todo normalization: content and status are required strings, priority
// and id are kept when present and generated (deterministic, position based)
// when absent. Items the V1 contract cannot express are dropped.
function normalizeTodoEntries(value: unknown, sessionID: string): Todo[] {
  if (!Array.isArray(value)) return []
  const todos: Todo[] = []
  for (const entry of value) {
    if (!isTodoEntry(entry)) continue
    const content = entry["content"]
    const status = entry["status"]
    if (typeof content !== "string" || typeof status !== "string") continue
    const priority = entry["priority"]
    const id = entry["id"]
    todos.push({
      content,
      status,
      priority: typeof priority === "string" ? priority : "",
      id: typeof id === "string" && id.length > 0 ? id : todoID(sessionID, todos.length),
    })
  }
  return todos
}

export async function readSessionTodos(ctx: TodoReadContext, sessionID: string): Promise<Todo[]> {
  const info = await ctx.session.get({ sessionID })
  return normalizeTodoEntries(info.metadata?.[OMO_TODOS_METADATA_KEY], sessionID)
}

export async function writeSessionTodos(
  ctx: TodoStoreContext,
  sessionID: string,
  todos: readonly unknown[],
): Promise<Todo[]> {
  const stored = normalizeTodoEntries(todos, sessionID)
  await updateSessionMetadata(ctx, sessionID, { [OMO_TODOS_METADATA_KEY]: stored })
  return stored
}
