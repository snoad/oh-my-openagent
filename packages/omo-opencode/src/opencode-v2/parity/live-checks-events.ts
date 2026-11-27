import { fail, pass, readCapturedEvents, readText, type LiveCheck } from "./live-check-context"
import { parseEventStats, statsEntryForDirectory } from "./live-check-stats"

// Strict live checks for the event pipeline rows (plan task 20). L-11 and
// L-24 depend on the translator stats lines that the runtime emits at
// cleanup, so the cleanup-dependent assertions are evaluated in the POST
// phase (after the driver stopped the server and copied the final logs) and
// merged into the final verdicts. A missing stats line is FAIL: "not proven"
// is never PASS.

const EVENT_MARKER = "[opencode-v2] hook event fired"
const IDLE_MARKER = "[opencode-v2] hook experimental.idle fired"

// The V2 event types whose arrival triggers a snapshot refresh (a context
// fetch), from SNAPSHOT_DIFF_V2_SOURCES in events/v1-event-catalog.ts. Used
// as the capture sanity input for L-24; the budget bound itself comes from
// the cleanup stats line.
const FETCH_WORTHY_PATTERN =
  /^session\.(message\.content\.updated|tool\.input\.started|tool\.input\.delta|tool\.input\.ended|tool\.called|tool\.progress|tool\.success|tool\.failed|step\.started|step\.first-token|step\.streamed|message\.updated|message\.part\.updated|message\.removed)/

// L-11: event pipeline markers for session created, status idle and
// execution end appear for one run; plus (post phase) the cleanup stats line
// for the scenario A directory reports translated > 0.
export const checkEventPipeline: LiveCheck = async (ctx) => {
  const pluginLog = readText(ctx.pluginLogPath)
  const scenario = ctx.manifest.scenarios.a
  if (scenario === undefined) {
    return fail("manifest carries no scenario a", "L-11 FAIL: scenario a missing from the manifest.\n")
  }
  const events = readCapturedEvents(scenario.eventsFile).filter(
    (event) => event.sessionID === undefined || event.sessionID === scenario.sessionID,
  )
  const types = events.map((event) => event.type)
  const eventMarker = pluginLog.includes(EVENT_MARKER)
  const idleMarker = pluginLog.includes(IDLE_MARKER)
  const created = types.includes("session.created")
  const terminal = types.some((type) => type.startsWith("session.execution.") || type.startsWith("session.step."))
  const statsEntries = parseEventStats(pluginLog)
  const statsEntry = statsEntryForDirectory(statsEntries, scenario.directory)
  const evidence = [
    `L-11 phase=${ctx.phase}: event pipeline markers + cleanup stats.`,
    `sessionID: ${scenario.sessionID}`,
    `marker '${EVENT_MARKER}': ${eventMarker ? "present" : "MISSING"}`,
    `marker '${IDLE_MARKER}': ${idleMarker ? "present" : "MISSING"}`,
    `session.created in the event capture: ${created}`,
    `terminal session.execution.*/session.step.* event: ${terminal}`,
    `scenario A directory: ${scenario.directory ?? "(not recorded)"}`,
    `stats lines parsed: ${statsEntries.length}`,
    ...statsEntries.map((entry) => `  ${JSON.stringify(entry)}`),
    `events file: ${scenario.eventsFile}`,
    "",
  ].join("\n")
  if (!eventMarker) return fail("event marker missing from the plugin log", evidence)
  if (!idleMarker) return fail("experimental.idle marker missing from the plugin log", evidence)
  if (!created) return fail("session.created missing from the event capture", evidence)
  if (!terminal) return fail("no terminal session.execution.*/session.step.* event in the capture", evidence)
  if (ctx.phase === "post") {
    if (statsEntries.length === 0) {
      return fail(
        "no [opencode-v2] event stats line in the post-shutdown plugin log (translated count not proven)",
        evidence,
      )
    }
    if (statsEntry === undefined) {
      return fail(
        `no event stats line for the scenario A directory '${scenario.directory}' (translated count not proven)`,
        evidence,
      )
    }
    if (!(statsEntry.translated > 0)) {
      return fail(
        `cleanup stats line for the scenario A directory reports translated=${statsEntry.translated}`,
        evidence,
      )
    }
    return pass(
      `event markers held and the cleanup stats line for the scenario A directory reports translated=${statsEntry.translated}`,
      evidence,
    )
  }
  return pass(
    "event markers, session.created, idle and terminal execution event are present (cleanup stats line is evaluated in the post phase)",
    evidence,
  )
}

// L-24: translator budget for scenario B. From the cleanup stats line whose
// directory is the scenario B project directory:
// contextFetches <= fetchWorthy + coalesceBatches. A missing stats line is
// FAIL, so a translator that fetched a thousand times can never pass.
export const checkTranslatorBudget: LiveCheck = async (ctx) => {
  const scenario = ctx.manifest.scenarios.b
  if (scenario === undefined) {
    return fail("manifest carries no scenario b", "L-24 FAIL: scenario b missing from the manifest.\n")
  }
  const pluginLog = readText(ctx.pluginLogPath)
  const events = readCapturedEvents(scenario.eventsFile).filter(
    (event) => event.sessionID === undefined || event.sessionID === scenario.sessionID,
  )
  const fetchWorthyEvents = events.filter((event) => FETCH_WORTHY_PATTERN.test(event.type)).length
  const statsEntries = parseEventStats(pluginLog)
  const statsEntry = statsEntryForDirectory(statsEntries, scenario.directory)
  const evidence = [
    `L-24 phase=${ctx.phase}: translator fetch budget from the pinned stats contract.`,
    `sessionID: ${scenario.sessionID}`,
    `scenario B directory: ${scenario.directory ?? "(not recorded)"}`,
    `fetch-worthy events in the scenario B capture: ${fetchWorthyEvents}`,
    `stats lines parsed: ${statsEntries.length}`,
    ...statsEntries.map((entry) => `  ${JSON.stringify(entry)}`),
    `bound rule: contextFetches <= fetchWorthy + coalesceBatches (from the stats line itself)`,
    "",
  ].join("\n")
  if (fetchWorthyEvents === 0) return fail("no fetch-worthy events captured for scenario B", evidence)
  if (ctx.phase === "post") {
    if (statsEntry === undefined) {
      return fail(
        `no [opencode-v2] event stats line for the scenario B directory '${scenario.directory ?? "(not recorded)"}' (the fetch count is not proven)`,
        evidence,
      )
    }
    const bound = statsEntry.fetchWorthy + statsEntry.coalesceBatches
    if (statsEntry.contextFetches > bound) {
      return fail(
        `contextFetches ${statsEntry.contextFetches} exceeds fetchWorthy ${statsEntry.fetchWorthy} + coalesceBatches ${statsEntry.coalesceBatches} = ${bound}`,
        evidence,
      )
    }
    return pass(
      `contextFetches ${statsEntry.contextFetches} <= fetchWorthy ${statsEntry.fetchWorthy} + coalesceBatches ${statsEntry.coalesceBatches} (cleanup stats line for '${statsEntry.directory}')`,
      evidence,
    )
  }
  return pass(
    "scenario B capture present; the contextFetches bound is evaluated in the post phase from the cleanup stats line",
    evidence,
  )
}
