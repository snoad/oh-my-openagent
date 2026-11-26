import { expect } from "./bun-test-shim"

import { createV2ClientShim } from "../client/v2-client-shim"
import { callOps, newSession, row, rowSetup } from "./rows-h-client"
import { defineGroup, type ParityRow } from "./rows"

// Wave-1 H-CLIENT lifecycle rows (plan task 12): the session create/list/get/
// delete/children/todo shim methods. Shares the H-CLIENT id space with
// rows-h-client.ts and rows-h-client-misc.ts.

async function checkCreate(): Promise<void> {
  const { ctx, shim } = rowSetup()
  const result = await shim.session.create({ body: { title: "h-client", parentID: "ses_parent" } })
  expect(callOps(ctx, "session.create")).toBe(1)
  expect(result.data?.parentID).toBe("ses_parent")
  expect(result.data?.directory).toBe(ctx.location.directory)
}

async function checkList(): Promise<void> {
  const { ctx, shim } = rowSetup()
  await newSession(shim, ctx)
  await newSession(shim, ctx)
  const result = await shim.session.list()
  expect(callOps(ctx, "session.list")).toBeGreaterThanOrEqual(1)
  expect(result.data).toHaveLength(2)
}

async function checkGet(): Promise<void> {
  const { ctx, shim } = rowSetup()
  const sessionID = await newSession(shim, ctx)
  const result = await shim.session.get({ path: { id: sessionID } })
  expect(callOps(ctx, "session.get")).toBe(1)
  expect(result.data?.id).toBe(sessionID)
  expect(result.data?.title).toBe("h-client")
}

async function checkDelete(): Promise<void> {
  const { ctx, shim } = rowSetup()
  const sessionID = await newSession(shim, ctx)
  expect((await shim.session.delete({ path: { id: sessionID } })).data).toBe(false)
  const removed: string[] = []
  const withRemove = createV2ClientShim(
    {
      ...ctx,
      session: {
        ...ctx.session,
        remove: async (input: { sessionID: string }) => {
          removed.push(input.sessionID)
        },
      },
    },
    { promptWaitPollMs: 1 },
  )
  await withRemove.session.delete({ path: { id: sessionID } })
  expect(removed).toEqual([sessionID])
}

async function checkChildren(): Promise<void> {
  const { shim, ctx } = rowSetup()
  const parentID = await newSession(shim, ctx)
  const child = await shim.session.create({ body: { parentID, title: "child" } })
  const childID = child.data?.id
  if (childID === undefined) throw new Error("session create returned no id")
  await shim.session.create({ body: { title: "unrelated" } })
  const result = await shim.session.children({ path: { id: parentID } })
  expect(result.data).toHaveLength(1)
  expect(result.data?.[0]?.id).toBe(childID)
  expect(result.data?.[0]?.parentID).toBe(parentID)
}

async function checkTodo(): Promise<void> {
  const { shim, ctx } = rowSetup()
  const sessionID = await newSession(shim, ctx)
  expect((await shim.session.todo({ path: { id: sessionID } })).data).toEqual([])
}

export const hClientLifecycleRows: ParityRow[] = defineGroup("H-CLIENT", [
  row("CREATE", "session.create routes ctx.session.create and returns the V1 session shape", checkCreate),
  row("LIST", "session.list routes ctx.session.list and returns every V1 session", checkList),
  row("DELETE", "session.delete routes ctx.session.remove when present and answers false otherwise", checkDelete),
  row("GET", "session.get routes ctx.session.get and returns the V1 session", checkGet),
  row("CHILDREN", "session.children filters ctx.session.list by the parent linkage", checkChildren),
  row("TODO", "session.todo answers the empty V1 todo list", checkTodo),
])
