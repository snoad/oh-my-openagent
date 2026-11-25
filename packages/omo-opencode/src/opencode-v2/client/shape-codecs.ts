// Public surface of the V1 <-> OpenCode 2 session shape codecs (one module per
// codec family, re-exported here for the client shim and hook adapters).
export { fromV1Message } from "./from-v1-message"
export { toV1Messages } from "./to-v1-messages"
export { toV2PromptInput } from "./prompt-input-codec"
export { toV1SessionStatus } from "./status-codec"
export { fromV1ToolOutput, toV1ToolResult } from "./tool-result-codecs"
export type {
  V1FilePartInput,
  V1MessageInfo,
  V1MessageWithParts,
  V1Part,
  V1TextPartInput,
  V1ToolResult,
  V2ContextInput,
  V2MessageOut,
  V2PromptInputArgs,
  V2ToolResultInput,
} from "./shape-codec-types"
