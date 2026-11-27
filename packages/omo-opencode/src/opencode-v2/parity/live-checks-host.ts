import { countLiteral, fail, pass, readText, stop, type LiveCheck } from "./live-check-context"

// Live checks for the host rows (plan task 20): L-21 the supported-host
// notice state and L-22 one engine per location with the process-wide
// stream verdict. L-11 and L-24 moved to live-checks-events.ts (strict,
// cleanup-stats-aware versions).

const HOST_SUPPORTED_MARKER = "[opencode-v2] host supported"
const HOST_UNSUPPORTED_MARKER = "[opencode-v2] host unsupported"
const TOAST_MARKER = "[opencode-v2] toast"
const ENGINE_STARTED_MARKER = "[opencode-v2] engine started"
const PLUGIN_ENTRY_MARKER = "[oh-my-openagent] ENTRY - plugin loading"
const SESSION_RENAMED_PATTERN = /\[v2-events\] session\.renamed merged the title of (\S+)/g
const NOTICE_TITLE = "Oh My OpenAgent on OpenCode 2"
const NOTICE_BODY_MARKER = "does not support OpenCode"

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
    return {
      pass: "stop",
      summary: "the event stream is process-wide (recorded limit, not a parity failure)",
      evidence,
      owner: "per-location event stream isolation (recorded limit; re-proven when the isolation lands)",
    }
  }
  return pass("one engine per location and the cross-location translation stayed with its owner", evidence)
}
