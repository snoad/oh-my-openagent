import { fail, pass, readText, textLines, type LiveCheck, type LiveCheckContext } from "./live-check-context"

// Live check L-10 (plan task 25): the scripted grep tool call of scenario d
// (post phase, the capture exists only after the plugin reload) must return a
// string result in the V1 shape to the fake model.

function textOfToolOutput(raw: unknown): string {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray((parsed as { content?: unknown }).content)) {
        return (parsed as { content: Array<{ text?: unknown }> }).content
          .map((item) => (item !== null && typeof item === "object" && typeof item.text === "string" ? item.text : ""))
          .join("\n")
      }
    } catch {
      // the raw output is not JSON; the model received the plain string
    }
    return raw
  }
  if (raw !== null && typeof raw === "object" && typeof (raw as { text?: unknown }).text === "string") {
    return (raw as { text: string }).text
  }
  return JSON.stringify(raw) ?? ""
}

export const checkPluginGrepCall: LiveCheck = async (ctx) => {
  const scenarioD = ctx.manifest.scenarios.d
  if (scenarioD === undefined) return fail("manifest carries no scenario d", "L-10 FAIL: scenario d missing.\n")
  const lines = textLines(readText(scenarioD.requestsFile))
  let grepCallId: string | undefined
  let followUpOutput: string | undefined
  for (const line of lines) {
    let body: unknown
    try {
      body = JSON.parse(line)
    } catch {
      continue
    }
    const input = (body as { input?: unknown }).input
    if (!Array.isArray(input)) continue
    for (const item of input) {
      if (item === null || typeof item !== "object") continue
      const record = item as { type?: unknown; name?: unknown; call_id?: unknown; output?: unknown }
      if (record.type === "function_call" && record.name === "grep" && typeof record.call_id === "string") {
        grepCallId = record.call_id
      }
      if (record.type === "function_call_output" && grepCallId !== undefined && record.call_id === grepCallId) {
        followUpOutput = textOfToolOutput(record.output)
      }
    }
  }
  const output = followUpOutput ?? ""
  const evidence = [
    "L-10 PASS/FAIL: the fake model's grep call returned a string result in the V1 shape.",
    `scenario d sessionID: ${scenarioD.sessionID}`,
    `grep function_call observed with call_id: ${grepCallId ?? "MISSING"}`,
    `function_call_output found: ${followUpOutput !== undefined}`,
    `result text carries the matched file: ${output.includes("parity-file.txt")}; carries the V1 grep line: ${output.includes("parity row nine file")}`,
    "model-visible result text (first 20 lines, verbatim):",
    output
      .split("\n")
      .slice(0, 20)
      .map((line) => `  | ${line}`)
      .join("\n"),
    "",
  ].join("\n")
  if (grepCallId === undefined) return fail("no grep function_call in the scenario d requests", evidence)
  if (followUpOutput === undefined) return fail("no function_call_output for the grep call", evidence)
  if (!output.includes("parity-file.txt") || !output.includes("parity row nine file")) {
    return fail("the grep result text is not the V1-shaped string output", evidence)
  }
  return pass("the plugin grep tool answered the fake model with the V1 string output", evidence)
}
