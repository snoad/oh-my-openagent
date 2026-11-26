import { expect } from "./bun-test-shim"

import { createEventReplay, loadFixtureEvents } from "./fake-v2-event-replay"
import { defineGroup, type ParityRow, type ParityRowGroupItem } from "./rows"

// Wave-2 H-EVT performance row (plan task 14): replaying the recorded event
// streams over a synthetic 200-message session coalesces every snapshot
// refresh into one context() fetch per batch; the count is asserted on the
// fake ctx call log, never on wall-clock time.

function row(suffix: string, title: string, check: () => void | Promise<void>): ParityRowGroupItem {
  return { suffix, title, kind: "hermetic", is: ["IS-4", "IS-8"], wave: 2, status: "checked", check }
}

async function checkCoalescingPerformance(): Promise<void> {
  for (const fixture of ["events-a.jsonl", "events-b.jsonl"]) {
    const events = loadFixtureEvents(fixture)
    const sessionID = (events[0]?.data as { sessionID?: string } | undefined)?.sessionID ?? ""
    const replay = createEventReplay({ sessionID })
    for (let index = 0; index < 200; index += 1) {
      replay.pushContextEntry({
        id: `msg_perf_${index}`,
        type: "user",
        time: { created: index },
        text: `text ${index}`,
        files: [],
      })
    }
    for (const event of events) replay.push(event)
    const contextCalls = () => replay.ctx.__calls.filter((call) => call.op === "session.context").length
    expect(contextCalls(), `${fixture}: no fetch before the batch fires`).toBe(0)
    await replay.fire()
    expect(contextCalls(), `${fixture}: one coalesced fetch per batch`).toBe(1)
    await replay.fire()
    expect(contextCalls(), `${fixture}: no fetch without pending refreshes`).toBe(1)
  }
}

export const hEvtPerformanceRows: ParityRow[] = defineGroup("H-EVT", [
  row(
    "PERFORMANCE",
    "replaying the recorded streams coalesces every refresh into one context fetch per batch",
    checkCoalescingPerformance,
  ),
])
