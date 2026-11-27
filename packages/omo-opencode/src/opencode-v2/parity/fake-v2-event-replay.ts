import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import type { SessionMessageInfo } from "@opencode/client"
import { createFakeV2Context, type FakeV2Context } from "./fake-v2-context"
import type { FakeScheduler } from "./fake-v2-registry"
import { createSnapshotStore, type SnapshotStore } from "../events/snapshot-store"
import { translate } from "../events/v2-to-v1-events"
import type { V2IncomingEvent } from "../events/v2-event-payload"
import type { V1OutEvent } from "../events/v1-out-event"

// Event replay harness (plan task 14): drives the recorded host-2.4.1 event
// streams through translate with the fake session store advanced between
// events. The manual scheduler makes the coalesced snapshot refreshes
// deterministic: fire() runs the pending batches and one macrotask flush
// lets the context() fetch resolve before the diff events land in out.

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/host-2.4.1", import.meta.url))

type ManualEventScheduler = FakeScheduler & {
  readonly fire: () => void
}

export function createManualEventScheduler(): ManualEventScheduler {
  const pending: Array<() => void> = []
  let sequence = 0
  return {
    now: () => {
      sequence += 1
      return sequence
    },
    setTimeout: (callback, _ms) => {
      pending.push(callback)
      return () => {
        const index = pending.indexOf(callback)
        if (index >= 0) pending.splice(index, 1)
      }
    },
    fire: () => {
      const batch = [...pending]
      pending.length = 0
      for (const callback of batch) callback()
    },
  }
}

export type EventReplay = {
  readonly ctx: FakeV2Context
  readonly store: SnapshotStore
  readonly out: V1OutEvent[]
  readonly sessionID: string
  push(event: V2IncomingEvent): void
  pushContextEntry(entry: SessionMessageInfo): void
  fire(): Promise<void>
}

// The fake session create body holds no await, so the session record is set
// synchronously and the replay stays a synchronous constructor.
export function createEventReplay(input: { sessionID: string; debug?: (message: string) => void }): EventReplay {
  const scheduler = createManualEventScheduler()
  const ctx = createFakeV2Context({ scheduler })
  void ctx.session.create({ id: input.sessionID })
  const out: V1OutEvent[] = []
  const store = createSnapshotStore({
    ctx,
    onEvents: (events) => {
      out.push(...events)
    },
    scheduler,
    debug: input.debug,
  })
  return {
    ctx,
    store,
    out,
    sessionID: input.sessionID,
    push: (event) => {
      out.push(...translate(event, store))
    },
    pushContextEntry: (entry) => {
      ctx.__sessions.get(input.sessionID)?.context.push(entry)
    },
    fire: async () => {
      scheduler.fire()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    },
  }
}

// The sync variant feeds translate directly without a live session; no
// refresh is ever fetched, so the payload parsing is the only behavior.
export function createSyncEventReplay(input: { debug?: (message: string) => void }): EventReplay {
  const scheduler = createManualEventScheduler()
  const ctx = createFakeV2Context({ scheduler })
  const out: V1OutEvent[] = []
  const store = createSnapshotStore({
    ctx,
    onEvents: (events) => {
      out.push(...events)
    },
    scheduler,
    debug: input.debug,
  })
  return {
    ctx,
    store,
    out,
    sessionID: "",
    push: (event) => {
      out.push(...translate(event, store))
    },
    pushContextEntry: () => undefined,
    fire: async () => {
      scheduler.fire()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    },
  }
}

// The fixture loaders are synchronous: the consuming tests index their
// results directly (loadFixtureEvents(name)[0], loadFixtureContext(name)[1])
// without awaiting, so the recorded streams read from disk up front.
export function loadFixtureEvents(name: string): readonly V2IncomingEvent[] {
  const content = readFileSync(`${FIXTURES_DIR}/${name}`, "utf8")
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as V2IncomingEvent)
}

export function loadFixtureContext(name: string): readonly SessionMessageInfo[] {
  const parsed = JSON.parse(readFileSync(`${FIXTURES_DIR}/${name}`, "utf8")) as { data?: SessionMessageInfo[] }
  if (parsed.data === undefined) throw new Error(`fixture ${name} carries no context data`)
  return parsed.data
}
