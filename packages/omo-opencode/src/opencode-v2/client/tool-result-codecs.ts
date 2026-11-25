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
