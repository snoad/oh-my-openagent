import type { SessionInboxUser, SessionPromptInput } from "@opencode/client"
import type { V2ShimContext } from "./shim-context"

// The single OpenCode 2 admission call site of the V1 client shim (plan task
// 12, seam allow-list item 2): every prompt the shim admits goes through
// admitPrompt, which stamps metadata.omo.internal = true so internal
// continuations stay separable from real user prompts (the idle budget of plan
// task 19 keys on that tag). It performs no dispatch by itself: the gate-routed
// dispatch of prompt-async-gate decides when admission happens, and this file
// is the raw route the audit allow-list tracks. The prompt text is never
// altered; only the metadata bag gains the tag.

type PromptMetadata = NonNullable<SessionPromptInput["metadata"]>
type MutablePromptMetadata = { [key: string]: PromptMetadata[string] }

function withInternalTag(input: SessionPromptInput): SessionPromptInput {
  const metadata: MutablePromptMetadata = { ...(input.metadata ?? {}) }
  const existing = metadata["omo"]
  const omo: MutablePromptMetadata =
    typeof existing === "object" && existing !== null && !Array.isArray(existing) ? { ...existing } : {}
  omo["internal"] = true
  metadata["omo"] = omo
  return { ...input, metadata }
}

export async function admitPrompt(ctx: V2ShimContext, input: SessionPromptInput): Promise<SessionInboxUser> {
  return ctx.session.prompt(withInternalTag(input))
}
