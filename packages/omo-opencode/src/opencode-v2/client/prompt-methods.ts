import type {
  AgentPartInput,
  FilePartInput,
  SessionPromptAsyncData,
  SessionPromptData,
  SubtaskPartInput,
  TextPartInput,
} from "@opencode-ai/sdk"
import type { SessionPromptInput } from "@opencode/client"
import { toV2PromptInput } from "./prompt-input-codec"
import { admitPrompt } from "./prompt-raw"
import { ensureSessionSnapshot, type SessionSnapshotCache } from "./session-snapshot-cache"
import type { V2ShimContext } from "./shim-context"
import type { V1Part } from "./shape-codec-types"
import type { V1SessionShimSurface } from "./v1-client-surface"
import { v1NotFound, v1Success } from "./v1-client-surface"

// The admission methods of the V2 client shim (plan task 12). Both route the
// V1 prompt body through the toV2PromptInput codec and the single raw
// admission call site (prompt-raw.ts). promptAsync returns the V1 204 envelope
// once the admission is accepted; prompt waits until the session reports idle
// (the 2.4.1 execution end collapses into idle), interrupting the session when
// the caller's abort signal fires, and answers with the newest assistant pair
// built through toV1Messages.

const PROMPT_ROUTE = "/session/{id}/message"
const PROMPT_ASYNC_ROUTE = "/session/{id}/prompt_async"

type V1AsyncPromptOptions = Omit<SessionPromptAsyncData, "url">
type V1SyncPromptOptions = Omit<SessionPromptData, "url">
type V1PromptBody = NonNullable<V1AsyncPromptOptions["body"]>
type V1PromptPath = { readonly id: string } | string

export type V2PromptMethodDeps = {
  readonly ctx: V2ShimContext
  readonly cache: SessionSnapshotCache
  readonly waitPollMs: number
}

function sessionIDOf(path: V1PromptPath): string {
  return typeof path === "string" ? path : path.id
}

// The V1 REST body carries input parts; the prompt codec consumes V1 parts
// (the output form, whose ids the V1 server assigns). The ids below are
// synthesized the same way and are never read by the codec. Subtask parts
// have no OpenCode 2 admission equivalent and fail loud.
function admissionParts(
  sessionID: string,
  parts: ReadonlyArray<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>,
): V1Part[] {
  const messageID = `${sessionID}:admission`
  return parts.map((part, index) => {
    const id = part.id ?? `${messageID}:${index}`
    if (part.type === "text") return { id, sessionID, messageID, type: "text", text: part.text }
    if (part.type === "file") {
      return {
        id,
        sessionID,
        messageID,
        type: "file",
        mime: part.mime,
        url: part.url,
        ...(part.filename === undefined ? {} : { filename: part.filename }),
      }
    }
    if (part.type === "agent") return { id, sessionID, messageID, type: "agent", name: part.name }
    throw new Error(`v2 client shim: V1 prompt part type "${part.type}" has no OpenCode 2 admission equivalent`)
  })
}

async function admit(
  ctx: V2ShimContext,
  cache: SessionSnapshotCache,
  sessionID: string,
  body: V1PromptBody | undefined,
): Promise<void> {
  const input: SessionPromptInput = toV2PromptInput({
    sessionID,
    parts: admissionParts(sessionID, body?.parts ?? []),
    ...(body?.agent === undefined ? {} : { agent: body.agent }),
  })
  cache.invalidate(sessionID)
  await admitPrompt(ctx, input)
}

async function waitUntilIdle(
  ctx: V2ShimContext,
  sessionID: string,
  signal: AbortSignal | null | undefined,
  pollMs: number,
): Promise<void> {
  for (;;) {
    const info = await ctx.session.get({ sessionID })
    if (info.time.busy === undefined) return
    if (signal?.aborted) {
      await ctx.session.interrupt({ sessionID })
      return
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

export function createPromptMethods(deps: V2PromptMethodDeps): Pick<V1SessionShimSurface, "prompt" | "promptAsync"> {
  const { ctx, cache, waitPollMs } = deps
  return {
    async promptAsync(options) {
      const path = options?.path
      if (path === undefined) throw new Error("v2 client shim: promptAsync requires a session path")
      await admit(ctx, cache, sessionIDOf(path), options.body)
      return v1Success(undefined, PROMPT_ASYNC_ROUTE, 204)
    },

    async prompt(options) {
      const path = options?.path
      if (path === undefined) throw new Error("v2 client shim: prompt requires a session path")
      const sessionID = sessionIDOf(path)
      await admit(ctx, cache, sessionID, options.body)
      await waitUntilIdle(ctx, sessionID, options?.signal, waitPollMs)
      const pairs = await ensureSessionSnapshot(ctx, cache, sessionID)
      const lastAssistant = [...pairs].reverse().find((pair) => pair.info.role === "assistant")
      return lastAssistant === undefined
        ? v1NotFound(`session ${sessionID} produced no assistant message`, PROMPT_ROUTE)
        : v1Success(lastAssistant, PROMPT_ROUTE)
    },
  }
}
