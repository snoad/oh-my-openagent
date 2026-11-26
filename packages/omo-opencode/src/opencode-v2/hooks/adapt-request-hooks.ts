import { createV2ClientShim } from "../client/v2-client-shim"
import type { V1ClientShimSurface } from "../client/v1-client-surface"
import type { V2RuntimePluginContext } from "../runtime/start-v2-runtime"
import { markHook } from "../runtime/hook-markers"
import type { V2Runtime } from "../runtime/stop-v2-runtime"

// registerRequestHookAdapters (plan task 18): bridges the OpenCode 2
// session.hook("model.request") hook to the V1 engine's chat.headers handler.
// The 2.4.1 host fires model.request for every request kind
// (primary/compaction/title/generate) with mutable headers and no message
// field, so the adapter resolves the session's latest user message through
// the V1 client shim's session.message surface, calls the V1 handler with
// the tolerant input { sessionID, provider: { id }, message: { id, role } }
// and merges the produced headers into event.headers. A failing message
// lookup is logged and leaves the headers unchanged instead of rejecting the
// model request; a throw from the V1 handler propagates unchanged (that is
// the veto path).

export type V2ModelRequestEvent = {
  readonly sessionID: string
  readonly kind: "primary" | "compaction" | "title" | "generate"
  readonly model: { readonly id: string; readonly providerID: string }
  readonly headers: Record<string, string>
  readonly message?: { readonly id?: string; readonly role?: string }
}

type V2HookRegistration = { readonly dispose: () => Promise<void> }

// The plugin ctx the hook adapters consume: V2RuntimePluginContext plus the
// host session hook registrar. The static shim context slice omits hook, so
// the registration adapters extend it here instead of touching the runtime.
export type V2SessionHookContext = V2RuntimePluginContext & {
  readonly session: V2RuntimePluginContext["session"] & {
    readonly hook: (
      name: "model.request",
      callback: (event: V2ModelRequestEvent) => void | Promise<void>,
    ) => Promise<V2HookRegistration>
  }
}

// The V1 chat.headers handler surface, read through the tolerant input shape
// SRC/plugin/chat-headers.ts buildChatHeadersInput accepts (the strict V1
// Hooks input carries agent/model fields the adapter does not need to fake).
type V1ChatHeadersMessage = { readonly id?: string; readonly role?: string }

type V1ChatHeadersHandler = (
  input: {
    readonly sessionID: string
    readonly provider: { readonly id: string }
    readonly message: V1ChatHeadersMessage
  },
  output: { readonly headers: Record<string, string> },
) => Promise<void> | void

function carriedMessage(event: V2ModelRequestEvent): V1ChatHeadersMessage | undefined {
  const message = event.message
  if (message === undefined) return undefined
  return { id: message.id, role: message.role }
}

async function resolveMessage(client: V1ClientShimSurface, sessionID: string): Promise<V1ChatHeadersMessage> {
  const listed = await client.session.messages({ path: { id: sessionID } })
  let latestUserID: string | undefined
  for (const pair of listed.data ?? []) {
    if (pair.info.role === "user") latestUserID = pair.info.id
  }
  if (latestUserID === undefined) return {}
  const single = await client.session.message({ path: { id: sessionID, messageID: latestUserID } })
  if (single.data === undefined) {
    console.warn(`[opencode-v2] chat.headers: session.message lookup failed for ${sessionID}/${latestUserID}`)
    return {}
  }
  return { id: single.data.info.id, role: single.data.info.role }
}

export function registerRequestHookAdapters(input: {
  readonly ctx: V2SessionHookContext
  readonly runtime: V2Runtime
  readonly client?: V1ClientShimSurface
}): void {
  const client = input.client ?? createV2ClientShim(input.ctx)
  const handler = input.runtime.engine["chat.headers"] as unknown as V1ChatHeadersHandler | undefined
  void input.ctx.session.hook("model.request", async (event) => {
    markHook("chat.headers", event.sessionID)
    let message = carriedMessage(event)
    if (message === undefined) {
      try {
        message = await resolveMessage(client, event.sessionID)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        console.warn(`[opencode-v2] chat.headers: session.message lookup failed for ${event.sessionID}: ${detail}`)
        message = {}
      }
    }
    const output = { headers: {} as Record<string, string> }
    if (handler !== undefined) {
      await handler({ sessionID: event.sessionID, provider: { id: event.model.providerID }, message }, output)
    }
    for (const [key, value] of Object.entries(output.headers)) {
      event.headers[key] = value
    }
  })
}
