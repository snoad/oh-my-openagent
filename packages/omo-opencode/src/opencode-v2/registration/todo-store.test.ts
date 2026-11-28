import { describe, expect, it } from "bun:test"

import { createFakeV2Context } from "../parity/fake-v2-context"
import { OMO_TODOS_METADATA_KEY, readSessionTodos, updateSessionMetadata, writeSessionTodos } from "./todo-store"

// Todo store tests (plan task 29): the metadata merge never overwrites other
// keys, two concurrent updateSessionMetadata calls both land (no lost update,
// ordered by explicit promises) and the todo roundtrip keeps the V1 Todo shape
// with deterministic ids.

type MetadataRead = { readonly metadata?: Record<string, unknown> }

function operationRecorder(ctx: ReturnType<typeof createFakeV2Context>) {
  const ops: string[] = []
  return {
    ops,
    session: {
      get: async (input: { readonly sessionID: string }): Promise<MetadataRead> => {
        ops.push("get")
        return ctx.session.get(input)
      },
      update: async (input: { readonly sessionID: string; readonly metadata?: Record<string, unknown> }) => {
        ops.push(
          `update:${Object.keys(input.metadata ?? {})
            .sort()
            .join("+")}`,
        )
        await ctx.session.update(input)
      },
    },
  }
}

describe("updateSessionMetadata", () => {
  it("#given a session with existing metadata #when updateSessionMetadata writes a patch #then the patch merges and the other keys stay untouched", async () => {
    // given
    const ctx = createFakeV2Context()
    const created = await ctx.session.create({ id: "ses_merge" })
    await ctx.session.update({ sessionID: created.id, metadata: { "omo.goal": { text: "ship" }, notes: "keep" } })

    // when
    await updateSessionMetadata(ctx, created.id, { [OMO_TODOS_METADATA_KEY]: [{ content: "a", status: "pending" }] })

    // then
    const info = await ctx.session.get({ sessionID: created.id })
    expect(info.metadata?.notes).toBe("keep")
    expect(info.metadata?.["omo.goal"]).toEqual({ text: "ship" })
    expect(Array.isArray(info.metadata?.[OMO_TODOS_METADATA_KEY])).toBe(true)
  })

  it("#given two updateSessionMetadata calls issued while both are in flight #when both settle #then the writes serialized and both patches landed", async () => {
    // given: the first read parks on an explicit deferred until the test
    // releases it, so both calls are provably in flight before either settles
    const ctx = createFakeV2Context()
    const created = await ctx.session.create({ id: "ses_race" })
    const recorder = operationRecorder(ctx)
    let releaseFirstRead!: () => void
    const firstReadParked = new Promise<void>((resolve) => {
      releaseFirstRead = resolve
    })
    let firstReadSeen = false
    const gated = {
      session: {
        get: async (input: { readonly sessionID: string }): Promise<MetadataRead> => {
          if (!firstReadSeen) {
            firstReadSeen = true
            await firstReadParked
          }
          return recorder.session.get(input)
        },
        update: recorder.session.update,
      },
    }

    // when: both writes are issued before either settles
    const first = updateSessionMetadata(gated, created.id, { first: 1 })
    const second = updateSessionMetadata(gated, created.id, { second: 2 })
    releaseFirstRead()
    await Promise.all([first, second])

    // then: the second read-modify-write ran after the first write and
    // carried the merged metadata
    expect(recorder.ops).toEqual(["get", "update:first", "get", "update:first+second"])
    const info = await ctx.session.get({ sessionID: created.id })
    expect(info.metadata?.first).toBe(1)
    expect(info.metadata?.second).toBe(2)
  })

  it("#given a failing metadata write #when a later write for the same session runs #then the later write still lands", async () => {
    // given
    const ctx = createFakeV2Context()
    const created = await ctx.session.create({ id: "ses_fail" })
    const failing = {
      session: {
        get: async (input: { readonly sessionID: string }): Promise<MetadataRead> => ctx.session.get(input),
        update: async () => {
          throw new Error("write failed")
        },
      },
    }
    await expect(updateSessionMetadata(failing, created.id, { boom: true })).rejects.toThrow("write failed")

    // when
    await updateSessionMetadata(ctx, created.id, { recovered: true })

    // then
    const info = await ctx.session.get({ sessionID: created.id })
    expect(info.metadata?.recovered).toBe(true)
  })
})

describe("writeSessionTodos and readSessionTodos", () => {
  it("#given todo entries with and without ids #when writeSessionTodos stores them #then the read returns the V1 Todo shape with stable ids", async () => {
    // given
    const ctx = createFakeV2Context()
    const created = await ctx.session.create({ id: "ses_todos" })
    const todos = [
      { content: "restore me", status: "in_progress", priority: "high", id: "orchestrate-plan" },
      { content: "generated id", status: "pending", priority: "low" },
    ]

    // when
    const stored = await writeSessionTodos(ctx, created.id, todos)

    // then
    expect(stored.map((todo) => todo.id)).toEqual(["orchestrate-plan", "ses_todos:1"])
    expect(await readSessionTodos(ctx, created.id)).toEqual(stored)
  })

  it("#given entries the V1 contract cannot express #when writeSessionTodos normalizes #then invalid entries are dropped", async () => {
    // given
    const ctx = createFakeV2Context()
    const created = await ctx.session.create({ id: "ses_garbage" })

    // when
    const stored = await writeSessionTodos(ctx, created.id, [
      "not-an-object",
      { status: "pending" },
      { content: "valid", status: "completed", priority: "medium" },
    ])

    // then
    expect(stored).toHaveLength(1)
    expect(stored[0]?.content).toBe("valid")
    expect(await readSessionTodos(ctx, created.id)).toHaveLength(1)
  })

  it("#given the reserved metadata key #when the store writes todos #then the key name is omo.todos", async () => {
    // given
    const ctx = createFakeV2Context()
    const created = await ctx.session.create({ id: "ses_key" })

    // when
    await writeSessionTodos(ctx, created.id, [{ content: "x", status: "pending", priority: "low" }])

    // then
    const info = await ctx.session.get({ sessionID: created.id })
    expect(Object.keys(info.metadata ?? {})).toEqual([OMO_TODOS_METADATA_KEY])
    expect(OMO_TODOS_METADATA_KEY).toBe("omo.todos")
  })
})
