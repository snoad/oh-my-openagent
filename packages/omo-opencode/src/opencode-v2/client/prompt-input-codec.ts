import type { SessionPromptInput } from "@opencode/client"
import type { V1Part, V2PromptInputArgs } from "./shape-codec-types"

const isTextPart = (part: V1Part): part is Extract<V1Part, { type: "text" }> => part.type === "text"
const isFilePart = (part: V1Part): part is Extract<V1Part, { type: "file" }> => part.type === "file"

export function toV2PromptInput(args: V2PromptInputArgs): SessionPromptInput {
  const { sessionID, parts, text, agent, metadata } = args
  if (text === undefined && parts === undefined) {
    throw new Error("toV2PromptInput requires text or parts to build the prompt body")
  }
  const files = (parts ?? []).filter(isFilePart).map((part) => ({
    uri: part.url,
    ...(part.filename === undefined ? {} : { name: part.filename }),
  }))
  return {
    sessionID,
    text: text ?? (parts ?? []).filter(isTextPart).map((part) => part.text).join("\n"),
    ...(files.length === 0 ? {} : { files }),
    ...(agent === undefined ? {} : { agents: [{ name: agent }] }),
    ...(metadata === undefined ? {} : { metadata }),
  }
}
