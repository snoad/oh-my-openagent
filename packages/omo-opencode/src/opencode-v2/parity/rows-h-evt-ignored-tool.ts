import { expect } from "./bun-test-shim"

import { translate } from "../events/v2-to-v1-events"
import { createSyncEventReplay } from "./fake-v2-event-replay"
import { checkIgnoredEntry } from "./rows-h-evt-ignored"
import { defineGroup, type ParityRow, type ParityRowGroupItem } from "./rows"

// Wave-2 H-EVT ignored tool-lifecycle rows (plan task 14): the catalog
// entries whose V1 names the OpenCode 2 tool events never produce —
// session.next.tool.called (tool.called flows through the snapshot diff as
// message.part.updated) and the tool.execute.* hook names (adapted through
// ctx.tool.hook by task 15, never events).

const SESSION = "ses_h_evt_ignored_tool"

function row(suffix: string, title: string, check: () => void | Promise<void>): ParityRowGroupItem {
  return { suffix, title, kind: "hermetic", is: ["IS-4", "IS-8"], wave: 2, status: "checked", check }
}

function checkNextToolCalled(): void {
  const replay = createSyncEventReplay({})
  translate(
    {
      type: "session.step.started",
      created: 5,
      data: {
        sessionID: SESSION,
        assistantMessageID: "msg_a",
        agent: "build",
        model: { id: "m", providerID: "p" },
        started: 5,
      },
    },
    replay.store,
  )
  translate(
    {
      type: "session.tool.input.started",
      created: 6,
      data: { sessionID: SESSION, assistantMessageID: "msg_a", id: "call_1", name: "read" },
    },
    replay.store,
  )
  const events = translate(
    {
      type: "session.tool.called",
      created: 7,
      data: {
        sessionID: SESSION,
        assistantMessageID: "msg_a",
        id: "call_1",
        input: { path: "/tmp/x" },
        executed: false,
      },
    },
    replay.store,
  )
  checkIgnoredEntry(
    "session.next.tool.called",
    events.map((event) => event.type),
  )
  expect(events.map((event) => event.type)).toEqual(["message.part.updated"])
}

function checkToolExecuteHook(v1Type: "tool.execute.before" | "tool.execute.after"): void {
  const replay = createSyncEventReplay({})
  const events = translate(
    {
      type: "session.tool.success",
      created: 5,
      data: { sessionID: SESSION, assistantMessageID: "msg_a", id: "call_1", content: [] },
    },
    replay.store,
  )
  checkIgnoredEntry(
    v1Type,
    events.map((event) => event.type),
  )
}

export const hEvtIgnoredToolRows: ParityRow[] = defineGroup("H-EVT", [
  row(
    "NEXT-TOOL-CALLED",
    "session.next.tool.called is never emitted; tool.called flows through the snapshot diff",
    checkNextToolCalled,
  ),
  row("TOOL-EXECUTE-BEFORE", "tool.execute.before is a hook name adapted through ctx.tool.hook, never an event", () =>
    checkToolExecuteHook("tool.execute.before"),
  ),
  row("TOOL-EXECUTE-AFTER", "tool.execute.after is a hook name adapted through ctx.tool.hook, never an event", () =>
    checkToolExecuteHook("tool.execute.after"),
  ),
])
