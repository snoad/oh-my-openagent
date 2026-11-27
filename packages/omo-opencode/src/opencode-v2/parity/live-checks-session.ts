import { apiJson } from "./live-check-api"
import {
  fail,
  pass,
  readRequestBodies,
  readText,
  type LiveCheck,
  type LiveCheckContext,
  type LiveScenarioRun,
} from "./live-check-context"

// Live checks for the session rows driven by the fake model request log
// (plan task 20): L-07 the chat.message marker plus the admitted text, L-08
// the system transform marker plus the system content of the first request,
// L-09 the tool execute markers plus the read/shell tool results. The wave-2
// observable core is asserted; sub-assertions whose parity surface has not
// landed yet (the Sisyphus system line, the hashline LINE# tags, the guard
// veto text) are recorded as GAP lines for the owning later-wave task.

const CHAT_MESSAGE_MARKER = "[opencode-v2] hook chat.message fired"
const SYSTEM_TRANSFORM_MARKER = "[opencode-v2] hook experimental.chat.system.transform fired"
const TOOL_BEFORE_MARKER = "[opencode-v2] hook tool.execute.before fired"
const TOOL_AFTER_MARKER = "[opencode-v2] hook tool.execute.after fired"
const GUARD_LOG_PREFIX = "[bash-file-read-guard] warned on bash file read command"
const HASHLINE_TAG_PATTERN = /\d+#[A-Z]{2,}\|/

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

function toolResultText(contextBody: unknown, toolName: string): string {
  if (contextBody === null || typeof contextBody !== "object") return ""
  const data = (contextBody as { data?: unknown }).data
  if (!Array.isArray(data)) return ""
  for (const message of data) {
    if (message === null || typeof message !== "object") continue
    const parts = (message as { content?: unknown }).content
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (part === null || typeof part !== "object") continue
      const record = part as { type?: unknown; name?: unknown; state?: { content?: unknown } }
      if (record.type !== "tool" || record.name !== toolName) continue
      const content = record.state?.content
      if (!Array.isArray(content)) return ""
      return content
        .map((entry) =>
          entry !== null && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string"
            ? (entry as { text: string }).text
            : "",
        )
        .join("\n")
    }
  }
  return ""
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

// L-08: the first fake model request carries the system content and the
// system transform marker is in the plugin log.
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
  const sisyphusPresent = sisyphusLine !== "" && first.includes(sisyphusLine)
  const evidence = [
    `L-08 ${markerPresent && hasSystem ? "PASS" : "FAIL"}: system transform marker + system content.`,
    `sessionID: ${scenario.sessionID}`,
    `marker '${SYSTEM_TRANSFORM_MARKER}': ${markerPresent ? "present" : "MISSING"}`,
    `first request carries a system/developer message: ${hasSystem}`,
    `sisyphus prompt first line: ${sisyphusLine || "(fixture unavailable)"}`,
    `sisyphus first line in first request: ${sisyphusPresent}`,
    sisyphusPresent
      ? "system marker at full strength: the Sisyphus prompt reached the model request"
      : "GAP (wave 2): the agent registration (plan task 24, wave 3) has not landed, the system is the host default agent prompt; the marker + system assertions are the wave-2 core",
    "",
  ].join("\n")
  if (!markerPresent) return fail("experimental.chat.system.transform marker missing", evidence)
  if (!hasSystem) return fail("first fake model request carries no system message", evidence)
  return pass("system transform marker present and the first request carries system content", evidence)
}

// L-09: scenario B (read tool call) and scenario C (shell cat) tool hooks.
export const checkToolHooks: LiveCheck = async (ctx) => {
  const scenarioB = scenarioOr(ctx, "b")
  const scenarioC = scenarioOr(ctx, "c")
  if (scenarioB === undefined || scenarioC === undefined) {
    return fail("manifest carries no scenarios b/c", "L-09 FAIL: scenarios b/c missing from the manifest.\n")
  }
  const pluginLog = readText(ctx.pluginLogPath)
  const pluginFileLog = readText(ctx.manifest.pluginFileLog ?? "")
  const beforeMarker = pluginLog.includes(TOOL_BEFORE_MARKER)
  const afterMarker = pluginLog.includes(TOOL_AFTER_MARKER)
  const contextB = await apiJson(ctx, `/api/session/${scenarioB.sessionID}/context`)
  const contextC = await apiJson(ctx, `/api/session/${scenarioC.sessionID}/context`)
  const readResult = toolResultText(contextB, "read")
  const shellResult = toolResultText(contextC, "shell")
  const readTagged = HASHLINE_TAG_PATTERN.test(readResult)
  const guardFired = pluginFileLog.includes(GUARD_LOG_PREFIX)
  const guardMessage = readGuardMessage()
  const vetoPresent = guardMessage !== "" && shellResult.includes(guardMessage)
  const core = beforeMarker && afterMarker && readResult !== "" && shellResult !== "" && guardFired
  const evidence = [
    `L-09 ${core ? "PASS" : "FAIL"}: tool execute markers + read/shell results + guard fired.`,
    `scenario B sessionID: ${scenarioB.sessionID}; scenario C sessionID: ${scenarioC.sessionID}`,
    `marker '${TOOL_BEFORE_MARKER}': ${beforeMarker ? "present" : "MISSING"}`,
    `marker '${TOOL_AFTER_MARKER}': ${afterMarker ? "present" : "MISSING"}`,
    `scenario B read tool result: ${readResult === "" ? "MISSING" : "present"}`,
    `scenario B read result carries a hashline LINE# tag: ${readTagged}`,
    readTagged
      ? ""
      : "GAP (wave 2): the hashline read enhancer does not recognize the OpenCode 2 read output format yet; the tag assertion lands with the hashline parity owner",
    `scenario C shell tool result: ${shellResult === "" ? "MISSING" : "present"}`,
    `guard warn line in the plugin file log: ${guardFired}`,
    `guard veto message in the shell result: ${vetoPresent}`,
    vetoPresent
      ? ""
      : "GAP (wave 2): the tool execute adapter drops the V1 output.message veto (plan task 15 bridge decision); the guard firing is proven through the plugin file log line",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n")
  if (!beforeMarker) return fail("tool.execute.before marker missing", evidence)
  if (!afterMarker) return fail("tool.execute.after marker missing", evidence)
  if (readResult === "") return fail("scenario B read tool result missing from the session context", evidence)
  if (shellResult === "") return fail("scenario C shell tool result missing from the session context", evidence)
  if (!guardFired) return fail("bash-file-read-guard warn line missing from the plugin file log", evidence)
  return pass("tool execute markers, read and shell results, and the guard warn line are present", evidence)
}

function readGuardMessage(): string {
  const guardModule = readText(`${import.meta.dir}/../../hooks/bash-file-read-guard.ts`)
  const match = /WARNING_MESSAGE\s*=\s*\n?\s*"((?:[^"\\]|\\.)*)"/.exec(guardModule)
  if (match === null) return ""
  return match[1]?.replace(/\\`/g, "`").replace(/\\n/g, "\n") ?? ""
}
