import {
  countLiteral,
  fail,
  pass,
  readCapturedEvents,
  readText,
  stop,
  textLines,
  type LiveCheck,
} from "./live-check-context"

// Live checks for the host rows (plan task 20): L-11 the event pipeline
// markers and the translated-event counters, L-15 the isolation digests and
// the sandbox removal (post phase), L-21 the supported-host notice state,
// L-22 one engine per location with the process-wide stream verdict, L-24
// the translator fetch budget inputs for scenario B.

const EVENT_MARKER = "[opencode-v2] hook event fired"
const IDLE_MARKER = "[opencode-v2] hook experimental.idle fired"
const HOST_SUPPORTED_MARKER = "[opencode-v2] host supported"
const HOST_UNSUPPORTED_MARKER = "[opencode-v2] host unsupported"
const TOAST_MARKER = "[opencode-v2] toast"
const ENGINE_STARTED_MARKER = "[opencode-v2] engine started"
const PLUGIN_ENTRY_MARKER = "[oh-my-openagent] ENTRY - plugin loading"
const FETCH_FAILURE_PATTERN = /\[v2-events\] context fetch failed for (\S+)/g
const SESSION_RENAMED_PATTERN = /\[v2-events\] session\.renamed merged the title of (\S+)/g
const NOTICE_TITLE = "Oh My OpenAgent on OpenCode 2"
const NOTICE_BODY_MARKER = "does not support OpenCode"

// The V2 event types whose arrival triggers a snapshot refresh (a context
// fetch), from SNAPSHOT_DIFF_V2_SOURCES in events/v1-event-catalog.ts.
const FETCH_WORTHY_PATTERN =
  /^session\.(message\.content\.updated|tool\.input\.started|tool\.input\.delta|tool\.input\.ended|tool\.called|tool\.progress|tool\.success|tool\.failed|step\.started|step\.first-token|step\.streamed|message\.updated|message\.part\.updated|message\.removed)/

// L-11: event pipeline markers for session created, status idle and
// execution end appear for one run; the translated-event counters are logged
// at cleanup.
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
  const counters: Record<string, number> = {}
  for (const type of types) counters[type] = (counters[type] ?? 0) + 1
  const eventMarker = pluginLog.includes(EVENT_MARKER)
  const idleMarker = pluginLog.includes(IDLE_MARKER)
  const created = types.includes("session.created")
  const terminal = types.some((type) => type.startsWith("session.execution.") || type.startsWith("session.step."))
  const core = eventMarker && idleMarker && created && terminal
  const evidence = [
    `L-11 ${core ? "PASS" : "FAIL"}: event pipeline markers and translated-event counters.`,
    `sessionID: ${scenario.sessionID}`,
    `marker '${EVENT_MARKER}': ${eventMarker ? "present" : "MISSING"}`,
    `marker '${IDLE_MARKER}': ${idleMarker ? "present" : "MISSING"}`,
    `session.created in the event capture: ${created}`,
    `terminal session.execution.*/session.step.* event: ${terminal}`,
    "[opencode-v2] event stats " + JSON.stringify(counters),
    `events file: ${scenario.eventsFile}`,
    "",
  ].join("\n")
  if (!eventMarker) return fail("event marker missing from the plugin log", evidence)
  if (!idleMarker) return fail("experimental.idle marker missing from the plugin log", evidence)
  if (!created) return fail("session.created missing from the event capture", evidence)
  if (!terminal) return fail("no terminal session.execution.*/session.step.* event in the capture", evidence)
  return pass("event markers, session.created, idle and terminal execution event are present", evidence)
}

// L-21: a supported host shows the host supported marker, no unsupported
// line and no floor toast marker in the TUI smoke capture.
export const checkHostNotice: LiveCheck = async (ctx) => {
  const pluginLog = readText(ctx.pluginLogPath)
  const supported = countLiteral(pluginLog, HOST_SUPPORTED_MARKER)
  const unsupported = pluginLog.includes(HOST_UNSUPPORTED_MARKER)
  const tuiLog = ctx.manifest.tuiSmokeLog === undefined ? "" : readText(ctx.manifest.tuiSmokeLog)
  const tuiProvided = ctx.manifest.tuiSmokeLog !== undefined
  const floorNotice = tuiLog.includes(NOTICE_TITLE) || tuiLog.includes(NOTICE_BODY_MARKER)
  const toastInServe = pluginLog.includes(TOAST_MARKER)
  const toastInTui = tuiProvided && tuiLog.includes(TOAST_MARKER)
  const core = supported > 0 && !unsupported && !toastInServe && !toastInTui && !floorNotice && tuiProvided
  const evidence = [
    `L-21 ${core ? "PASS" : "FAIL"}: supported host shows no notice.`,
    `marker '${HOST_SUPPORTED_MARKER}' count in the plugin log: ${supported}`,
    `marker '${HOST_UNSUPPORTED_MARKER}': ${unsupported ? "PRESENT" : "absent"}`,
    `tui smoke log: ${ctx.manifest.tuiSmokeLog ?? "(not provided)"}`,
    `floor notice text in the TUI smoke log: ${floorNotice}`,
    `toast marker '${TOAST_MARKER}' in the plugin log: ${toastInServe}`,
    `toast marker in the TUI smoke log: ${toastInTui}`,
    "",
  ].join("\n")
  if (supported === 0) return fail("host supported marker missing from the plugin log", evidence)
  if (unsupported) return fail("host unsupported line present in the plugin log", evidence)
  if (!tuiProvided) return fail("manifest carries no TUI smoke log", evidence)
  if (floorNotice) return fail("floor notice text found in the TUI smoke log", evidence)
  if (toastInServe || toastInTui) return fail("floor toast marker found", evidence)
  return pass("host supported marker present, no unsupported line, no floor toast", evidence)
}

// L-22: one server with two locations starts one engine per location, the
// process-wide side-effect lines stay single-run, and the cross-location
// event isolation is graded (STOP when the event stream is process-wide).
export const checkLocationEngines: LiveCheck = async (ctx) => {
  const pluginLog = readText(ctx.pluginLogPath)
  const engineCount = countLiteral(pluginLog, ENGINE_STARTED_MARKER)
  const entryCount = countLiteral(pluginLog, PLUGIN_ENTRY_MARKER)
  const locationCount = ctx.manifest.locations.length
  const sessionLocations = ctx.manifest.locations.filter((loc) => loc.sessionID !== undefined && loc.name !== "serve")
  const second = sessionLocations[sessionLocations.length - 1]
  const renamedLines = [...pluginLog.matchAll(SESSION_RENAMED_PATTERN)].map((match) => match[1])
  const crossLines = second === undefined ? [] : renamedLines.filter((sid) => sid === second.sessionID)
  const countsOk = engineCount === locationCount && entryCount === locationCount
  const evidence = [
    `L-22 ${countsOk && crossLines.length === 1 ? "PASS" : countsOk ? "STOP" : "FAIL"}: location engines and process-wide stream verdict.`,
    `locations: ${ctx.manifest.locations.map((loc) => `${loc.name}=${loc.directory}`).join("; ")}`,
    `engine started lines: ${engineCount} (locations: ${locationCount})`,
    `plugin ENTRY lines: ${entryCount}`,
    second === undefined
      ? "no session-bearing second location in the manifest"
      : `session created in location '${second.name}': ${second.sessionID}`,
    `translations of that session's renamed event: ${crossLines.length}`,
    crossLines.length > 1
      ? "the event stream is process-wide: every location runtime translated the second location's session event (identical debug lines per runtime); reported as STOP per the row contract"
      : crossLines.length === 1
        ? "cross-location isolation held: only the owning location translated the session event"
        : "no renamed translation observed for the second location's session",
    "",
  ].join("\n")
  if (!countsOk) {
    return fail(
      `engine/ENTRY count mismatch (engines ${engineCount}, entries ${entryCount}, locations ${locationCount})`,
      evidence,
    )
  }
  if (crossLines.length > 1) {
    return stop("the event stream is process-wide (recorded limit, not a parity failure)", evidence)
  }
  return pass("one engine per location and the cross-location translation stayed with its owner", evidence)
}

// L-24: translator budget inputs for scenario B: the fetch-worthy event
// count, the coalescing batches and the fetch-failure lines.
export const checkTranslatorBudget: LiveCheck = async (ctx) => {
  const scenario = ctx.manifest.scenarios.b
  if (scenario === undefined) {
    return fail("manifest carries no scenario b", "L-24 FAIL: scenario b missing from the manifest.\n")
  }
  const pluginLog = readText(ctx.pluginLogPath)
  const events = readCapturedEvents(scenario.eventsFile).filter(
    (event) => event.sessionID === undefined || event.sessionID === scenario.sessionID,
  )
  const fetchWorthy = events.filter((event) => FETCH_WORTHY_PATTERN.test(event.type)).length
  const failures = textLines(pluginLog).filter((line) => FETCH_FAILURE_PATTERN.test(line)).length
  const bound = fetchWorthy + 1
  const core = fetchWorthy > 0 && failures <= bound
  const evidence = [
    `L-24 ${core ? "PASS" : "FAIL"}: translator budget inputs for scenario B.`,
    `sessionID: ${scenario.sessionID}`,
    `fetch-worthy events in the capture: ${fetchWorthy}`,
    `coalescing budget bound (fetch-worthy + one batch): ${bound}`,
    `context fetch failure lines in the plugin log: ${failures}`,
    "GAP (wave 2): the live translator emits no per-fetch success counter; the fetch-count assertion tightens when the translator stats seam lands (H-EVT-PERFORMANCE pins the coalescing bound hermetically today)",
    "",
  ].join("\n")
  if (fetchWorthy === 0) return fail("no fetch-worthy events captured for scenario B", evidence)
  if (failures > bound) {
    return fail(`context fetch failures ${failures} exceed the budget bound ${bound}`, evidence)
  }
  return pass("translator budget inputs recorded and within the bound", evidence)
}
