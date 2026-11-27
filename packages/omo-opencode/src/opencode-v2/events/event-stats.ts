import { log } from "../../shared"

// Event subscription stats (live rows L-11/L-24): one stats line per
// translating subscription, emitted once when the subscription stops. The
// marker prefix and the JSON keys are pinned by the live parity checks and
// the QA scripts that parse them; do not rename them.

export type V2EventStats = {
  directory: string
  eventsSeen: number
  translated: number
  fetchWorthy: number
  coalesceBatches: number
  contextFetches: number
  contextFetchFailures: number
}

// The fetch-side counters the snapshot store increments at its call sites;
// the subscription loop owns eventsSeen and translated.
export type V2EventFetchStats = Pick<
  V2EventStats,
  "fetchWorthy" | "coalesceBatches" | "contextFetches" | "contextFetchFailures"
>

export function createV2EventStats(): V2EventStats {
  return {
    directory: "",
    eventsSeen: 0,
    translated: 0,
    fetchWorthy: 0,
    coalesceBatches: 0,
    contextFetches: 0,
    contextFetchFailures: 0,
  }
}

function statsPayload(stats: V2EventStats): string {
  return JSON.stringify({
    directory: stats.directory,
    eventsSeen: stats.eventsSeen,
    translated: stats.translated,
    fetchWorthy: stats.fetchWorthy,
    coalesceBatches: stats.coalesceBatches,
    contextFetches: stats.contextFetches,
    contextFetchFailures: stats.contextFetchFailures,
  })
}

export function formatV2EventStats(stats: V2EventStats): string {
  return `[opencode-v2] event stats ${statsPayload(stats)}`
}

// The subscription debug channel prefixes [opencode-v2] itself (the default
// debug console.debug writer), so it receives the suffix only; the file log
// line is emitted with the full pinned marker.
export function emitV2EventStats(stats: V2EventStats, debug: (message: string) => void): void {
  debug(`event stats ${statsPayload(stats)}`)
  log(formatV2EventStats(stats))
}
