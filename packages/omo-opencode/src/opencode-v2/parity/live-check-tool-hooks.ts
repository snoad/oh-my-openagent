import { apiJson } from "./live-check-api"
import { fail, pass, readText, type LiveCheck, type LiveCheckContext, type LiveScenarioRun } from "./live-check-context"

// Strict L-09 (plan task 20): the scenario B read tool result carries a
// hashline LINE# tag in its model-visible content text, and the scenario C
// cat call was VETOED by the V1 bashFileReadGuard: state.status is "error",
// the guard WARNING_MESSAGE appears byte-for-byte in the error text and no
// line of the scenario file content leaks into the content or error text.
// Real 2.4.1 shapes (task-20 runtime capture): a completed read carries
// state.content as [{type:"text",text:"1#NS|..."}]; a vetoed call carries
// {"status":"error","content":null,"error":{"type":"unknown","message":"..."}}.
// The evidence quotes status, error and content verbatim.

const TOOL_BEFORE_MARKER = "[opencode-v2] hook tool.execute.before fired"
const TOOL_AFTER_MARKER = "[opencode-v2] hook tool.execute.after fired"
const GUARD_LOG_PREFIX = "[bash-file-read-guard] warned on bash file read command"
// Hashline tag format from packages/hashline-core (HASHLINE_OUTPUT_PATTERN):
// `<lineNumber>#<2 chars of HASHLINE_DICT ZPMQVRWSNKTXJBYH>|`.
const HASHLINE_TAG_PATTERN = /(?:^|\n)\d+#[ZPMQVRWSNKTXJBYH]{2}\|/

type ToolResultState = {
  readonly status: string
  readonly contentRaw: unknown
  readonly errorRaw: unknown
  readonly contentText: string
  readonly errorText: string
}

function scenarioOr(ctx: LiveCheckContext, key: "a" | "b" | "c"): LiveScenarioRun | undefined {
  return (ctx.manifest.scenarios as Record<string, LiveScenarioRun | undefined>)[key]
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map((entry) =>
      entry !== null && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string"
        ? (entry as { text: string }).text
        : "",
    )
    .join("\n")
}

function errorTextOf(error: unknown): string {
  if (typeof error === "string") return error
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  return ""
}

function jsonOrUndefined(value: unknown): string {
  return JSON.stringify(value) ?? "undefined"
}

// Model-visible result of a tool part (real 2.4.1 host shape): the text of
// state.content when it is an array, plus the error text when the call was
// vetoed (state.status "error"; state.error is {type, message} or a plain
// string).
function toolState(contextBody: unknown, toolName: string): ToolResultState | undefined {
  if (contextBody === null || typeof contextBody !== "object") return undefined
  const data = (contextBody as { data?: unknown }).data
  if (!Array.isArray(data)) return undefined
  for (const message of data) {
    if (message === null || typeof message !== "object") continue
    const parts = (message as { content?: unknown }).content
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (part === null || typeof part !== "object") continue
      const record = part as { type?: unknown; name?: unknown; state?: unknown }
      if (record.type !== "tool" || record.name !== toolName) continue
      if (record.state === null || typeof record.state !== "object") return undefined
      const state = record.state as { status?: unknown; content?: unknown; error?: unknown }
      return {
        status: typeof state.status === "string" ? state.status : "",
        contentRaw: state.content,
        errorRaw: state.error,
        contentText: textOfContent(state.content),
        errorText: errorTextOf(state.error),
      }
    }
  }
  return undefined
}

function verbatimQuote(text: string): string {
  return text
    .split("\n")
    .slice(0, 20)
    .map((line) => `  | ${line}`)
    .join("\n")
}

function trailingTrimmedLines(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/[ \t\r]+$/, ""))
}

// Line-by-line leak compare: a non-empty file line is a leak when a result
// line equals it after trailing-whitespace trim on both sides (a host that
// trims the final newline cannot hide a leak).
function firstLeakedLine(fileContent: string, texts: readonly string[]): string | undefined {
  for (const line of trailingTrimmedLines(fileContent)) {
    if (line.trim() === "") continue
    for (const text of texts) {
      if (trailingTrimmedLines(text).includes(line)) return line
    }
  }
  return undefined
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
  const readState = toolState(contextB, "read")
  const shellState = toolState(contextC, "shell")
  const readResult = readState === undefined ? "" : readState.contentText
  const readTagged = HASHLINE_TAG_PATTERN.test(readResult)
  const guardMessage = readGuardMessage()
  const vetoed = shellState !== undefined && shellState.status === "error"
  const vetoPresent = shellState !== undefined && guardMessage !== "" && shellState.errorText.includes(guardMessage)
  const fileContent = scenarioC.fileContent ?? ""
  const leakLine =
    shellState === undefined || fileContent === ""
      ? undefined
      : firstLeakedLine(fileContent, [shellState.contentText, shellState.errorText])
  const shellStateQuote =
    shellState === undefined
      ? "scenario C shell tool state: MISSING"
      : [
          `scenario C shell tool state.status: ${jsonOrUndefined(shellState.status)}`,
          `scenario C shell tool state.error: ${jsonOrUndefined(shellState.errorRaw)}`,
          `scenario C shell tool state.content: ${jsonOrUndefined(shellState.contentRaw)}`,
        ].join("\n")
  const evidence = [
    `L-09 PASS/FAIL: tool markers + hashline tag + vetoed shell call + no file-content leak.`,
    `scenario B sessionID: ${scenarioB.sessionID}; scenario C sessionID: ${scenarioC.sessionID}`,
    `marker '${TOOL_BEFORE_MARKER}': ${beforeMarker ? "present" : "MISSING"}`,
    `marker '${TOOL_AFTER_MARKER}': ${afterMarker ? "present" : "MISSING"}`,
    `scenario B read result carries a hashline LINE# tag: ${readTagged}`,
    `scenario C shell call vetoed (state.status is "error"): ${vetoed}`,
    `guard veto message found in the scenario C shell error text: ${vetoPresent}`,
    `scenario file content leaks into the shell content/error text: ${
      leakLine === undefined ? "false" : `true (line: ${leakLine})`
    }`,
    `guard warn line in the plugin file log: ${pluginFileLog.includes(GUARD_LOG_PREFIX)}`,
    `guard message source (hooks/bash-file-read-guard.ts WARNING_MESSAGE): ${guardMessage === "" ? "UNREADABLE" : "read"}`,
    shellStateQuote,
    "scenario B read tool result (first 20 lines, verbatim):",
    verbatimQuote(readResult),
    "scenario C shell tool content text (first 20 lines, verbatim):",
    verbatimQuote(shellState?.contentText ?? ""),
    "scenario C shell tool error text (first 20 lines, verbatim):",
    verbatimQuote(shellState?.errorText ?? ""),
    "",
  ].join("\n")
  if (!beforeMarker) return fail("tool.execute.before marker missing", evidence)
  if (!afterMarker) return fail("tool.execute.after marker missing", evidence)
  if (readState === undefined) return fail("scenario B read tool result missing from the session context", evidence)
  if (shellState === undefined) return fail("scenario C shell tool result missing from the session context", evidence)
  if (guardMessage === "")
    return fail("guard message source unreadable; the byte-for-byte veto cannot be proven", evidence)
  if (!readTagged) return fail("scenario B read tool result carries no hashline LINE# tag", evidence)
  if (fileContent === "")
    return fail("manifest carries no scenario file content; the absence of the file content is not proven", evidence)
  if (!vetoed)
    return fail(
      `scenario C shell call executed (state.status "${shellState.status}") instead of being vetoed`,
      evidence,
    )
  if (!vetoPresent)
    return fail("scenario C shell error text does not contain the V1 guard message byte-for-byte", evidence)
  if (leakLine !== undefined)
    return fail(`the scenario file's content leaked into the shell tool result (line: ${leakLine})`, evidence)
  return pass(
    "hashline tag on the read result; the shell call was vetoed with the guard message byte-for-byte; no file-content leak",
    evidence,
  )
}
