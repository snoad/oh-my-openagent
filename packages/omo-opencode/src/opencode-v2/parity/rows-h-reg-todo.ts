import { expect } from "./bun-test-shim"

import { checkToolFamily } from "./rows-h-reg-tools"
import { checkHostGateKeepsStore, checkV1HooksOnTodoNames } from "./rows-h-reg-todo-checks"
import { createFakeV2Context } from "./fake-v2-context"
import {
  OMO_TODOS_METADATA_KEY,
  readSessionTodos,
  updateSessionMetadata,
  writeSessionTodos,
} from "../registration/todo-store"
import { defineGroup, type ParityRow } from "./rows"

// Wave-3 H-REG todo rows (plan task 29): the plugin todo store (per-session
// metadata under the reserved omo.todos key behind the per-session metadata
// mutex) and the plugin todo tools with the V1 built-in contract, registered
// only when the host lacks todowrite.

async function checkStoreMerge(): Promise<void> {
  const ctx = createFakeV2Context()
  const created = await ctx.session.create({ id: "ses_row_merge" })
  await ctx.session.update({ sessionID: created.id, metadata: { foreign: "keep" } })
  await updateSessionMetadata(ctx, created.id, { [OMO_TODOS_METADATA_KEY]: [{ content: "a", status: "pending" }] })
  const info = await ctx.session.get({ sessionID: created.id })
  expect(info.metadata?.foreign).toBe("keep")
  expect(await readSessionTodos(ctx, created.id)).toHaveLength(1)
}

async function checkMetadataConcurrency(): Promise<void> {
  const ctx = createFakeV2Context()
  const created = await ctx.session.create({ id: "ses_row_race" })
  const first = updateSessionMetadata(ctx, created.id, { first: 1 })
  const second = updateSessionMetadata(ctx, created.id, { second: 2 })
  await Promise.all([first, second])
  const info = await ctx.session.get({ sessionID: created.id })
  expect(info.metadata?.first).toBe(1)
  expect(info.metadata?.second).toBe(2)
}

async function checkShimServesStore(): Promise<void> {
  const ctx = createFakeV2Context()
  await ctx.session.create({ id: "ses_row_shim" })
  const stored = await writeSessionTodos(ctx, "ses_row_shim", [
    { content: "row todo", status: "in_progress", priority: "high" },
  ])
  expect(await readSessionTodos(ctx, "ses_row_shim")).toEqual(stored)
  expect(stored.map((todo) => todo.id)).toEqual(["ses_row_shim:0"])
}

export const hRegTodoRows: ParityRow[] = defineGroup("H-REG", [
  {
    suffix: "TODO-STORE-MERGE",
    title: "session metadata writes through updateSessionMetadata merge and never overwrite other metadata keys",
    kind: "hermetic",
    is: ["IS-3"],
    wave: 3,
    status: "checked",
    check: checkStoreMerge,
  },
  {
    suffix: "TODO-METADATA-CONCURRENCY",
    title: "two concurrent session-metadata writes for one session both land with no lost update",
    kind: "hermetic",
    is: ["IS-3"],
    wave: 3,
    status: "checked",
    check: checkMetadataConcurrency,
  },
  {
    suffix: "TODO-TOOLS",
    title:
      "the plugin provides todowrite and todoread with the V1 built-in argument schema when the host lists no todowrite",
    kind: "hermetic",
    is: ["IS-3"],
    wave: 3,
    status: "checked",
    check: () => checkToolFamily(["todowrite", "todoread"]),
  },
  {
    suffix: "TODO-HOST-GATED",
    title:
      "when the host already lists todowrite the plugin registers no todo tool and the shim still serves session.todo through the store",
    kind: "hermetic",
    is: ["IS-3", "IS-8"],
    wave: 3,
    status: "checked",
    check: checkHostGateKeepsStore,
  },
  {
    suffix: "TODO-V1-HOOKS",
    title:
      "todoDescriptionOverride and tasksTodowriteDisabler keep their V1 behavior because the tool names are unchanged",
    kind: "hermetic",
    is: ["IS-4"],
    wave: 3,
    status: "checked",
    check: checkV1HooksOnTodoNames,
  },
  {
    suffix: "TODO-SHIM-STORE",
    title: "the shim session.todo serves the plugin store with the V1 Todo shape and stable ids",
    kind: "hermetic",
    is: ["IS-8"],
    wave: 3,
    status: "checked",
    check: checkShimServesStore,
  },
])
