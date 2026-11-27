import { apiJson } from "./live-check-api"
import { fail, pass, readText, type LiveCheck, type LiveCheckContext, type LiveScenarioRun } from "./live-check-context"

// Strict L-09 (plan task 20): the scenario B read tool result carries a
// hashline LINE# tag, the scenario C cat tool result contains the V1
// bashFileReadGuard WARNING_MESSAGE byte-for-byte, and the scenario file's
// content is absent from that result. The evidence quotes both tool results
// verbatim (first 20 lines each).

const TOOL_BEFORE_MARKER = "[opencode-v2] hook tool.execute.before fired"
const TOOL_AFTER_MARKER = "[opencode-v2] hook tool.execute.after fired"
const GUARD_LOG_PREFIX = "[bash-file-read-guard] warned on bash file read command"
// Hashline tag format from packages/hashline-core (HASHLINE_OUTPUT_PATTERN):
// `<lineNumber>#<2 chars of HASHLINE_DICT ZPMQVRWSNKTXJBYH>|`.
const HASHLINE_TAG_PATTERN = /(?:^|\n)\d+#[ZPMQVRWSNKTXJBYH]{2}\|/

function scenarioOr(ctx: LiveCheckContext, key: "a" | "b" | "c"): LiveScenarioRun | undefined {
  return (ctx.manifest.scenarios as Record<string, LiveScenarioRun | undefined>)[key]
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

function verbatimQuote(text: string): string {
  return text
    .split("\n")
    .slice(0, 20)
    .map((line) => `  | ${line}`)
    .join("\n")
}

function readGuardMessage(): string {
  const guardModule = readText(`${import.meta.dir}/../../hooks/bash-file-read-guard.ts`)
  const match = /WARNING_MESSAGE\s*=\s*\n?\s*"((?:[^"\\]|\\.)*)"/.exec(guardModule)
  if (match === null) return ""
  return match[1]?.replace(/\\`/g, "`").replace(/\\n/g, "\n") ?? ""
}

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
  const guardMessage = readGuardMessage()
  const vetoPresent = guardMessage !== "" && shellResult.includes(guardMessage)
  const fileContent = scenarioC.fileContent ?? ""
  const contentLeak = fileContent !== "" && shellResult.includes(fileContent)
  const evidence = [
    `L-09 PASS/FAIL: tool markers + hashline tag + byte-for-byte guard veto + no file-content leak.`,
    `scenario B sessionID: ${scenarioB.sessionID}; scenario C sessionID: ${scenarioC.sessionID}`,
    `marker '${TOOL_BEFORE_MARKER}': ${beforeMarker ? "present" : "MISSING"}`,
    `marker '${TOOL_AFTER_MARKER}': ${afterMarker ? "present" : "MISSING"}`,
    `scenario B read result carries a hashline LINE# tag: ${readTagged}`,
    `guard veto message found in the scenario C shell result: ${vetoPresent}`,
    `scenario file content leaks into the shell result: ${contentLeak}`,
    `guard warn line in the plugin file log: ${pluginFileLog.includes(GUARD_LOG_PREFIX)}`,
    `guard message source (hooks/bash-file-read-guard.ts WARNING_MESSAGE): ${guardMessage === "" ? "UNREADABLE" : "read"}`,
    "scenario B read tool result (first 20 lines, verbatim):",
    verbatimQuote(readResult),
    "scenario C shell tool result (first 20 lines, verbatim):",
    verbatimQuote(shellResult),
    "",
  ].join("\n")
  if (!beforeMarker) return fail("tool.execute.before marker missing", evidence)
  if (!afterMarker) return fail("tool.execute.after marker missing", evidence)
  if (readResult === "") return fail("scenario B read tool result missing from the session context", evidence)
  if (shellResult === "") return fail("scenario C shell tool result missing from the session context", evidence)
  if (guardMessage === "")
    return fail("guard message source unreadable; the byte-for-byte veto cannot be proven", evidence)
  if (!readTagged) return fail("scenario B read tool result carries no hashline LINE# tag", evidence)
  if (!vetoPresent)
    return fail("scenario C shell tool result does not contain the V1 guard message byte-for-byte", evidence)
  if (contentLeak) return fail("the scenario file's content leaked into the shell tool result (cat executed)", evidence)
  return pass(
    "hashline tag on the read result, guard veto byte-for-byte in the shell result, no file-content leak",
    evidence,
  )
}
