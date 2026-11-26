import type { Event } from "@opencode-ai/sdk"

import { v1EventSessionID } from "../events/v1-out-event"
import { subscribeV2Events, type V2EventSubscriptionContext } from "../events/subscribe-v2-events"
import { registerContextHookAdapter } from "../hooks/adapt-context-hook"
import { registerRequestHookAdapters, type V2SessionHookContext } from "../hooks/adapt-request-hooks"
import { registerModelResolveAdapter } from "../hooks/adapt-model-resolve"
import { registerPromptHookAdapter } from "../hooks/adapt-prompt-hook"
import { registerToolHookAdapters, type V2ToolHookContext } from "../hooks/adapt-tool-hooks"
import { markHook } from "./hook-markers"
import type { V2Runtime } from "./stop-v2-runtime"
import type { V2RuntimePluginContext } from "./start-v2-runtime"

// Ordered adapter registration list (plan task 13). The runtime applies every
// registration in order after the engine started, passing the ctx and the
// runtime record (engine hooks, abort signal). Task 14 adds the event
// translation adapter; tasks 15 to 19 and 22 to 28 append their registrations
// here, so a later wave only adds entries and never touches startV2Runtime
// again.

export type V2AdapterRegistration = {
  readonly id: string
  readonly register: (input: {
    readonly ctx: V2RuntimePluginContext
    readonly runtime: V2Runtime
  }) => void | Promise<void>
}

// Plan task 14: the translated V1 events reach the engine's event handler
// and the event hook marker fires once per session. The SDK's strict Event
// union cannot be honestly populated from OpenCode 2 payloads (the task-12
// message-mirror decision), so the tolerant V1OutEvent crosses at this one
// boundary; the runtime handler reads the event loosely.
const v2EventAdapterRegistration: V2AdapterRegistration = {
  id: "v2-events",
  register: ({ ctx, runtime }) => {
    void subscribeV2Events(
      ctx as V2RuntimePluginContext & V2EventSubscriptionContext,
      async ({ event }) => {
        const sessionID = v1EventSessionID(event)
        if (sessionID !== undefined) markHook("event", sessionID)
        await runtime.engine.event?.({ event: event as unknown as Event })
      },
      { signal: runtime.abort.signal },
    )
  },
}

// Plan task 18: the model.request hook reaches the engine's chat.headers
// handler; the session hook registrar is absent from the static shim context
// slice, so the registration narrows the ctx to the hook-capable view.
const v2RequestHooksAdapterRegistration: V2AdapterRegistration = {
  id: "v2-request-hooks",
  register: ({ ctx, runtime }) => {
    registerRequestHookAdapters({ ctx: ctx as V2SessionHookContext, runtime })
  },
}

// Plan task 17: one context hook registration routes the request payload
// through the V1 system/messages/params transforms (GAP-4 request
// transforms); the id-keyed write-back lives in hooks/context-message-*.
const v2ContextHookAdapterRegistration: V2AdapterRegistration = {
  id: "v2-context-hook",
  register: ({ ctx, runtime }) => {
    registerContextHookAdapter({ ctx, runtime })
  },
}

// Plan task 16: the prompt hook replays the V1 command interception and the
// chat.message handler against the mutable admission (GAP-4 prompt, GAP-7
// command entry); the model resolve adapter applies the same-provider model
// override the chat.message handler requested and drops cross-provider
// requests with the LIM-3 evidence.
const v2PromptHookAdapterRegistration: V2AdapterRegistration = {
  id: "v2-prompt-hook",
  register: ({ ctx, runtime }) => {
    void registerPromptHookAdapter({ ctx, runtime })
  },
}

const v2ModelResolveAdapterRegistration: V2AdapterRegistration = {
  id: "v2-model-resolve",
  register: ({ ctx, runtime }) => {
    void registerModelResolveAdapter({ ctx, runtime })
  },
}

// Plan task 15: the tool execute hooks reach the engine's tool.execute
// handlers with the aliased V1 tool names; the args write-back, the veto
// propagation and the failed-call mirror live in hooks/adapt-tool-hooks.
const v2ToolHooksAdapterRegistration: V2AdapterRegistration = {
  id: "v2-tool-hooks",
  register: ({ ctx, runtime }) => {
    registerToolHookAdapters(ctx as V2ToolHookContext, runtime.engine, markHook)
  },
}

export const v2AdapterRegistrations: readonly V2AdapterRegistration[] = [
  v2EventAdapterRegistration,
  v2RequestHooksAdapterRegistration,
  v2ContextHookAdapterRegistration,
  v2PromptHookAdapterRegistration,
  v2ModelResolveAdapterRegistration,
  v2ToolHooksAdapterRegistration,
]
