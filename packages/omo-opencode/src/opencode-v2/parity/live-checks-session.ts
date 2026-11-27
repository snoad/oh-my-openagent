import {
  fail,
  partial,
  pass,
  readRequestBodies,
  readText,
  type LiveCheck,
  type LiveCheckContext,
  type LiveScenarioRun,
} from "./live-check-context"

// Live checks for the session rows driven by the fake model request log
// (plan task 20): L-07 the chat.message marker plus the admitted text, L-08
// the system transform marker plus the system content of the first request.
// L-09 moved to live-check-tool-hooks.ts (strict version).

const CHAT_MESSAGE_MARKER = "[opencode-v2] hook chat.message fired"
const SYSTEM_TRANSFORM_MARKER = "[opencode-v2] hook experimental.chat.system.transform fired"

const L08_OWNER = "agent registration, plan task 24; re-proven by IS-5"

function scenarioOr(ctx: LiveCheckContext, key: "a" | "b" | "c"): LiveScenarioRun | undefined {
  return (ctx.manifest.scenarios as Record<string, LiveScenarioRun | undefined>)[key]
}

function sisyphusPromptFirstLine(): string {
  try {
    const parsed = JSON.parse(readText(`${import.meta.dir}/fixtures/v1-baseline/agent-prompts.json`)) as {
      sisyphus?: unknown
    }
    if (typeof parsed.sisyphus !== "string") return ""
    return parsed.sisyphus.split("\n")[0] ?? ""
  } catch {
    return ""
  }
}

// L-07: scenario A (plain text answer) shows the chat.message marker and the
// admitted text in the fake model request.
export const checkChatMessageAdmission: LiveCheck = async (ctx) => {
  const scenario = scenarioOr(ctx, "a")
  const pluginLog = readText(ctx.pluginLogPath)
  const markerPresent = pluginLog.includes(CHAT_MESSAGE_MARKER)
  if (scenario === undefined) {
    return fail("manifest carries no scenario a", "L-07 FAIL: scenario a missing from the manifest.\n")
  }
  const bodies = readRequestBodies(scenario.requestsFile)
  const admitted = bodies.filter((body) => body.includes(scenario.prompt)).length
  const evidence = [
    `L-07 ${markerPresent && admitted > 0 ? "PASS" : "FAIL"}: chat.message marker + admitted text.`,
    `sessionID: ${scenario.sessionID}`,
    `plugin log: ${ctx.pluginLogPath}`,
    `marker '${CHAT_MESSAGE_MARKER}': ${markerPresent ? "present" : "MISSING"}`,
    `requests recorded: ${bodies.length}; bodies containing the admitted prompt: ${admitted}`,
    `prompt: ${scenario.prompt}`,
    "",
  ].join("\n")
  if (!markerPresent) return fail("chat.message marker missing from the plugin log", evidence)
  if (admitted === 0) return fail("admitted prompt text not found in any fake model request", evidence)
  return pass("chat.message marker present and the admitted text reached the model request", evidence)
}

// L-08: PASS requires the system transform marker, a system message in the
// first fake model request AND the Sisyphus prompt first line. When the
// sisyphus line is absent (agent registration lands with plan task 24) the
// check answers partial with the named owner instead of PASS.
export const checkSystemTransform: LiveCheck = async (ctx) => {
  const scenario = scenarioOr(ctx, "a")
  const pluginLog = readText(ctx.pluginLogPath)
  const markerPresent = pluginLog.includes(SYSTEM_TRANSFORM_MARKER)
  if (scenario === undefined) {
    return fail("manifest carries no scenario a", "L-08 FAIL: scenario a missing from the manifest.\n")
  }
  const bodies = readRequestBodies(scenario.requestsFile)
  const first = bodies[0] ?? ""
  const hasSystem = first.includes('"role":"developer"') || first.includes('"role":"system"')
  const sisyphusLine = sisyphusPromptFirstLine()
  // The raw request body embeds prompt text inside JSON strings, so double
  // quotes arrive backslash-escaped; match both the plain and escaped forms.
  const sisyphusEscaped = sisyphusLine.split('"').join('\\"')
  const sisyphusPresent = sisyphusLine !== "" && (first.includes(sisyphusLine) || first.includes(sisyphusEscaped))
  const verdict =
    markerPresent && hasSystem && sisyphusPresent ? "PASS" : markerPresent && hasSystem ? "PARTIAL" : "FAIL"
  const evidence = [
    `L-08 ${verdict}: system transform marker + system content + sisyphus system line.`,
    `sessionID: ${scenario.sessionID}`,
    `marker '${SYSTEM_TRANSFORM_MARKER}': ${markerPresent ? "present" : "MISSING"}`,
    `first request carries a system/developer message: ${hasSystem}`,
    `sisyphus prompt first line: ${sisyphusLine || "(fixture unavailable)"}`,
    `sisyphus first line in first request: ${sisyphusPresent}`,
    `held assertions: system transform marker, system content in the first request`,
    `deferred assertion: the Sisyphus system line (owner: ${L08_OWNER})`,
    "",
  ].join("\n")
  if (!markerPresent) return fail("experimental.chat.system.transform marker missing", evidence)
  if (!hasSystem) return fail("first fake model request carries no system message", evidence)
  if (!sisyphusPresent) {
    return partial(
      "system transform marker and system content held; the Sisyphus system line is deferred (owner: agent registration, plan task 24; re-proven by IS-5)",
      evidence,
      L08_OWNER,
    )
  }
  return pass(
    "system transform marker present, first request carries system content and the Sisyphus prompt line",
    evidence,
  )
}
