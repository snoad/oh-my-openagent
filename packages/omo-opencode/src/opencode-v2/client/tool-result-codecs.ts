import type { V1ToolResult, V2ToolContentOut, V2ToolResultInput } from "./shape-codec-types"

export function toV1ToolResult(result: V2ToolResultInput): V1ToolResult {
  const content = result.content ?? []
  const lines = content.map((item): string => (item.type === "text" ? item.text : fileLine(item)))
  return {
    ...(result.title === undefined ? {} : { title: result.title }),
    output: lines.join("\n"),
    ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
  }
}

function fileLine(item: Extract<V2ToolContentOut, { type: "file" }>): string {
  return `[file ${item.name ?? "unnamed"} ${item.mime} ${item.uri}]`
}

export function fromV1ToolOutput(output: string): V2ToolContentOut[] {
  return [{ type: "text", text: output }]
}

// The OpenCode 2 read tool (2.4.1) prefixes the numbered body with a summary
// header line; the V1 hashline-read-enhancer only recognizes a body that
// starts at a numbered line, so the header is dropped when a numbered line
// follows. A V1-shaped output (or a result without numbered lines) passes
// through unchanged.
const V2_READ_LINE_PATTERN = /^\s*\d+[:|] ?/

export function normalizeV2ReadOutput(output: string): string {
  const lines = output.split("\n")
  const first = lines.findIndex((line) => V2_READ_LINE_PATTERN.test(line))
  if (first <= 0) return output
  return lines.slice(first).join("\n")
}

// V1-shaped read result for the OpenCode 2 read tool: the header lines are
// normalized away before the engine's after-hooks run, so the V1 enhancer
// tags the body exactly like a V1 read output (live row L-09, scenario B).
export function toV1ReadToolResult(result: V2ToolResultInput): V1ToolResult {
  const v1 = toV1ToolResult(result)
  return { ...v1, output: normalizeV2ReadOutput(v1.output) }
}
