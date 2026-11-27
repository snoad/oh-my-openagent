import { textLines } from "./live-check-context"

// The pinned translator stats contract (plan task 20): one line per event
// subscription at cleanup, `[opencode-v2] event stats ` + JSON on the same
// line, with the fields directory, eventsSeen, translated, fetchWorthy,
// coalesceBatches, contextFetches and contextFetchFailures. The line is
// emitted by the V2 events runtime when the server stops; the live checks
// parse THIS line and never synthesize their own counters.

export const EVENT_STATS_PREFIX = "[opencode-v2] event stats "

export type EventStatsEntry = {
  readonly directory: string
  readonly eventsSeen: number
  readonly translated: number
  readonly fetchWorthy: number
  readonly coalesceBatches: number
  readonly contextFetches: number
  readonly contextFetchFailures: number
}

const NUMERIC_FIELDS = [
  "eventsSeen",
  "translated",
  "fetchWorthy",
  "coalesceBatches",
  "contextFetches",
  "contextFetchFailures",
] as const

type StatsRecord = { directory?: unknown } & Partial<Record<(typeof NUMERIC_FIELDS)[number], unknown>>

function parseStatsLine(line: string): EventStatsEntry | undefined {
  if (!line.startsWith(EVENT_STATS_PREFIX)) return undefined
  let parsed: StatsRecord
  try {
    parsed = JSON.parse(line.slice(EVENT_STATS_PREFIX.length)) as StatsRecord
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || typeof parsed.directory !== "string") return undefined
  const numbers = {} as Record<(typeof NUMERIC_FIELDS)[number], number>
  for (const field of NUMERIC_FIELDS) {
    const value = parsed[field]
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined
    numbers[field] = value
  }
  return { directory: parsed.directory, ...numbers }
}

export function parseEventStats(logText: string): EventStatsEntry[] {
  const entries: EventStatsEntry[] = []
  for (const line of textLines(logText)) {
    const entry = parseStatsLine(line)
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}

export function statsEntryForDirectory(
  entries: readonly EventStatsEntry[],
  directory: string | undefined,
): EventStatsEntry | undefined {
  if (directory === undefined) return undefined
  return entries.find((entry) => entry.directory === directory)
}
