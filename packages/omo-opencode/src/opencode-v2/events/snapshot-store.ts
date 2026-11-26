import type { SessionMessageInfo } from "@opencode/client"

import { toV1Messages } from "../client/to-v1-messages"
import { diffSnapshots } from "./snapshot-diff"
import type { V1OutEvent, WritableV1SessionInfo } from "./v1-out-event"

// Per-session snapshot store (plan task 14): holds the V2 session entries,
// the V1 mirror the task-11 codec produces over them, and the session info
// registry. patch() returns the differences as V1 events; refresh requests
// for one session coalesce so N events cause one ctx.session.context call
// through the injectable scheduler; at most 64 sessions stay cached with the
// least recently used evicted; a deleted session is dropped and its pending
// refresh cancelled.

export type SnapshotStoreContext = {
  readonly session: {
    readonly context: (input: { readonly sessionID: string }) => Promise<readonly SessionMessageInfo[]>
  }
}

export type SnapshotScheduler = {
  readonly setTimeout: (callback: () => void, ms: number) => () => void
}

export type SnapshotStoreOptions = {
  readonly ctx: SnapshotStoreContext
  readonly onEvents: (events: readonly V1OutEvent[]) => void | Promise<void>
  readonly scheduler?: SnapshotScheduler
  readonly debug?: (message: string) => void
  readonly refreshDelayMs?: number
}

type SessionRecord = {
  info?: WritableV1SessionInfo
  entries: readonly SessionMessageInfo[]
  mirror: ReturnType<typeof toV1Messages>
  refreshCancel?: () => void
}

const MAX_SESSIONS = 64

function defaultSnapshotScheduler(): SnapshotScheduler {
  return {
    setTimeout: (callback, ms) => {
      const handle = setTimeout(callback, ms)
      return () => clearTimeout(handle)
    },
  }
}

export type SnapshotStore = {
  readonly debug: (message: string) => void
  patch(sessionID: string, entries: readonly SessionMessageInfo[]): V1OutEvent[]
  scheduleRefresh(sessionID: string): void
  drop(sessionID: string): void
  dispose(): void
  sessionCount(): number
  entries(sessionID: string): readonly SessionMessageInfo[]
  putSessionInfo(sessionID: string, info: WritableV1SessionInfo): void
  renameSession(sessionID: string, title: string): void
}

export function createSnapshotStore(options: SnapshotStoreOptions): SnapshotStore {
  const scheduler = options.scheduler ?? defaultSnapshotScheduler()
  const debug = options.debug ?? (() => undefined)
  const refreshDelayMs = options.refreshDelayMs ?? 0
  const records = new Map<string, SessionRecord>()

  const evictBeyondCapacity = (): void => {
    while (records.size > MAX_SESSIONS) {
      const oldest = records.keys().next().value
      if (oldest === undefined) return
      records.get(oldest)?.refreshCancel?.()
      records.delete(oldest)
    }
  }

  const touch = (sessionID: string): SessionRecord => {
    const existing = records.get(sessionID)
    if (existing !== undefined) {
      records.delete(sessionID)
      records.set(sessionID, existing)
      return existing
    }
    const record: SessionRecord = { entries: [], mirror: [] }
    records.set(sessionID, record)
    evictBeyondCapacity()
    return record
  }

  const patch = (sessionID: string, entries: readonly SessionMessageInfo[]): V1OutEvent[] => {
    const record = touch(sessionID)
    const mirror = toV1Messages({ messages: entries, sessionID })
    const events = diffSnapshots(sessionID, record.mirror, mirror)
    record.entries = entries
    record.mirror = mirror
    return events
  }

  const runRefresh = async (sessionID: string): Promise<void> => {
    let entries: readonly SessionMessageInfo[]
    try {
      entries = await options.ctx.session.context({ sessionID })
    } catch (error) {
      debug(
        `[v2-events] context fetch failed for ${sessionID}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    // An empty context response is not evidence that messages were removed
    // (the host may not have persisted the transcript yet), so only a
    // non-empty transcript reconciles the snapshot.
    if (entries.length === 0 || !records.has(sessionID)) return
    const events = patch(sessionID, entries)
    if (events.length > 0) await options.onEvents(events)
  }

  const scheduleRefresh = (sessionID: string): void => {
    const record = touch(sessionID)
    if (record.refreshCancel !== undefined) return
    record.refreshCancel = scheduler.setTimeout(() => {
      record.refreshCancel = undefined
      void runRefresh(sessionID)
    }, refreshDelayMs)
  }

  return {
    debug,
    patch,
    scheduleRefresh,
    drop: (sessionID) => {
      records.get(sessionID)?.refreshCancel?.()
      records.delete(sessionID)
    },
    dispose: () => {
      for (const record of records.values()) record.refreshCancel?.()
      records.clear()
    },
    sessionCount: () => records.size,
    entries: (sessionID) => records.get(sessionID)?.entries ?? [],
    putSessionInfo: (sessionID, info) => {
      touch(sessionID).info = info
    },
    renameSession: (sessionID, title) => {
      const info = records.get(sessionID)?.info
      if (info !== undefined) info.title = title
    },
  }
}
