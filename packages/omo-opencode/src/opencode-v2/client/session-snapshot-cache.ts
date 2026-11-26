import type { V1MessageWithParts } from "./shape-codec-types"
import { toV1Messages } from "./to-v1-messages"
import type { V2ShimContext } from "./shim-context"

// Per-session message snapshot cache backing session.messages/message of the
// V2 client shim (plan task 12). The engine reads messages at ~64 call sites,
// so a read must not refetch while the cache is fresh; an admission (prompt or
// promptAsync) invalidates the touched session. Plan task 14 replaces the
// admission-only invalidation with snapshots kept fresh by the session context
// event subscription, feeding the same store: this module is the seam it wires
// into.

type Snapshot = {
  readonly pairs: readonly V1MessageWithParts[]
}

export type SessionSnapshotCache = {
  readonly read: (sessionID: string) => readonly V1MessageWithParts[] | undefined
  readonly store: (sessionID: string, pairs: readonly V1MessageWithParts[]) => void
  readonly invalidate: (sessionID: string) => void
}

export function createSessionSnapshotCache(): SessionSnapshotCache {
  const snapshots = new Map<string, Snapshot>()
  return {
    read(sessionID) {
      return snapshots.get(sessionID)?.pairs
    },
    store(sessionID, pairs) {
      snapshots.set(sessionID, { pairs })
    },
    invalidate(sessionID) {
      snapshots.delete(sessionID)
    },
  }
}

// Cache-first read: a fresh snapshot is served without touching the ctx; a
// stale or missing one is fetched from ctx.session.context and stored.
export async function ensureSessionSnapshot(
  ctx: V2ShimContext,
  cache: SessionSnapshotCache,
  sessionID: string,
): Promise<readonly V1MessageWithParts[]> {
  const cached = cache.read(sessionID)
  if (cached !== undefined) return cached
  const entries = await ctx.session.context({ sessionID })
  const pairs = toV1Messages({ sessionID, data: entries })
  cache.store(sessionID, pairs)
  return pairs
}
