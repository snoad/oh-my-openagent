import { expect } from "./bun-test-shim"

import { createV2ClientShim } from "../client/v2-client-shim"
import { callOps, dispatchViaGate, newSession, row, rowSetup, seedAssistant } from "./rows-h-client"
import { defineGroup, type ParityRow } from "./rows"

// Wave-1 H-CLIENT message-domain rows (plan task 12): the session
// messages/message/status/abort/summarize shim methods. Shares the H-CLIENT id
// space with rows-h-client.ts, rows-h-client-lifecycle.ts and
// rows-h-client-misc.ts.

async function checkMessages(): Promise<void> {
  const { ctx, shim } = rowSetup()
  const sessionID = await newSession(shim, ctx)
  seedAssistant(ctx, sessionID)
  const record = ctx.__sessions.get(sessionID)
  if (record === undefined) throw new Error(`unknown session ${sessionID}`)
  record.context.unshift({ id: "msg_row_user", type: "user", time: { created: 1 }, text: "question", files: [] })
  const first = await shim.session.messages({ path: { id: sessionID } })
  const second = await shim.session.messages({ path: { id: sessionID } })
  expect(callOps(ctx, "session.context")).toBe(1)
  expect(second.data).toEqual(first.data)
  expect(first.data?.[0]?.info.id).toBe("msg_row_user")
  const limited = await shim.session.messages({ path: { id: sessionID }, query: { limit: 1 } })
  expect(limited.data).toHaveLength(1)
  expect(limited.data?.[0]?.info.id).toBe("msg_row_assistant")
}

async function checkMessage(): Promise<void> {
  const { shim, ctx } = rowSetup()
  const sessionID = await newSession(shim, ctx)
  seedAssistant(ctx, sessionID)
  const found = await shim.session.message({ path: { id: sessionID, messageID: "msg_row_assistant" } })
  expect(found.data?.info.id).toBe("msg_row_assistant")
  expect(found.data?.info.role).toBe("assistant")
  const missing = await shim.session.message({ path: { id: sessionID, messageID: "msg_missing" } })
  expect(missing.data).toBeUndefined()
}

async function checkStatus(): Promise<void> {
  const { ctx, shim } = rowSetup()
  const sessionID = await newSession(shim, ctx)
  const idle = await shim.session.status()
  await dispatchViaGate(shim, sessionID, "busy work")
  const busy = await shim.session.status()
  // each status() call lists once; the gate-routed admission between them adds
  // its own status read, so the floor is two
  expect(callOps(ctx, "session.list")).toBeGreaterThanOrEqual(2)
  expect(idle.data?.[sessionID]).toEqual({ type: "idle" })
  expect(busy.data?.[sessionID]).toEqual({ type: "busy" })
}

async function checkAbort(): Promise<void> {
  const { ctx, shim } = rowSetup()
  const sessionID = await newSession(shim, ctx)
  await dispatchViaGate(shim, sessionID, "busy work")
  expect((await shim.session.abort({ path: { id: sessionID } })).data).toBe(true)
  expect(callOps(ctx, "session.interrupt")).toBe(1)
  expect((await shim.session.abort({ path: { id: sessionID } })).data).toBe(false)
}

async function checkSummarize(): Promise<void> {
  const { shim, ctx } = rowSetup()
  const sessionID = await newSession(shim, ctx)
  expect((await shim.session.summarize({ path: { id: sessionID } })).data).toBe(false)
  const compacted: string[] = []
  const withCompact = createV2ClientShim(
    {
      ...ctx,
      session: {
        ...ctx.session,
        compact: async (input: { sessionID: string }) => {
          compacted.push(input.sessionID)
        },
      },
    },
    { promptWaitPollMs: 1 },
  )
  await withCompact.session.summarize({ path: { id: sessionID } })
  expect(compacted).toEqual([sessionID])
}

export const hClientMessageRows: ParityRow[] = defineGroup("H-CLIENT", [
  row(
    "MESSAGES",
    "session.messages serves the cached V1 pairs without refetching while fresh and applies the limit",
    checkMessages,
  ),
  row("MESSAGE", "session.message returns the V1 pair by message id and undefined data for a miss", checkMessage),
  row("STATUS", "session.status returns the session-id keyed V1 status map seeded from ctx.session.get", checkStatus),
  row("ABORT", "session.abort routes ctx.session.interrupt and returns the interrupted flag", checkAbort),
  row(
    "SUMMARIZE",
    "session.summarize routes ctx.session.compact and answers false on the graceful path",
    checkSummarize,
  ),
])
