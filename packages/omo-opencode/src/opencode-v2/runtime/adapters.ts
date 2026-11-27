import type { Event } from "@opencode-ai/sdk"

import { v1EventSessionID } from "../events/v1-out-event"
import { subscribeV2Events, type V2EventSubscriptionContext } from "../events/subscribe-v2-events"
import { registerContextHookAdapter } from "../hooks/adapt-context-hook"
import { registerRequestHookAdapters, type V2SessionHookContext } from "../hooks/adapt-request-hooks"
import { registerModelResolveAdapter } from "../hooks/adapt-model-resolve"
import { registerPromptHookAdapter } from "../hooks/adapt-prompt-hook"
import { registerToolHookAdapters, type V2ToolHookContext } from "../hooks/adapt-tool-hooks"
import { registerCompactionHookAdapters } from "../hooks/adapt-compaction-hooks"
import { registerIdleContinuationAdapter } from "../hooks/adapt-idle-continuation"
import { createPlanSource } from "../registration/plan-source"
import type { PlanSourceContext } from "../registration/plan-source-context"
import { v2ProviderModelAdapterRegistration } from "./provider-model-adapter"
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
    const subscription = subscribeV2Events(
      ctx as V2RuntimePluginContext & V2EventSubscriptionContext,
      async ({ event }) => {
        const sessionID = v1EventSessionID(event)
        if (sessionID !== undefined) markHook("event", sessionID)
        await runtime.engine.event?.({ event: event as unknown as Event })
      },
      { signal: runtime.abort.signal },
    )
    runtime.subscriptions?.push(subscription)
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

// Plan task 19: the raw session.compaction lifecycle drives the V1
// capture/restore halves and the session compaction hook feeds the captured
// context into the compaction request; the restore runs through
// experimental.compaction.autocontinue exactly once per compaction.
const v2CompactionHooksAdapterRegistration: V2AdapterRegistration = {
  id: "v2-compaction-hooks",
  register: ({ ctx, runtime }) => {
    void registerCompactionHookAdapters({ ctx, runtime })
  },
}

// Plan task 19: the translated V1 session.idle event stays the only
// continuation trigger; the experimental.idle host hook registers as a
// marker and the per-session idle budget bounds consecutive gate-dispatched
// internal admissions.
const v2IdleContinuationAdapterRegistration: V2AdapterRegistration = {
  id: "v2-idle-continuation",
  register: ({ ctx, runtime }) => {
    registerIdleContinuationAdapter({ ctx, runtime })
  },
}

// Plan task 23: the registration plan source recomputes the V1 config
// pipeline into the registration plan (initial recompute awaited here) and
// subscribes the config.updated / *.updated debounce. A pipeline failure
// fails the plugin setup: the exact marker line plus the rejection, and no
// partial plan is applied (reloads only follow a successful diff).
const v2PlanSourceAdapterRegistration: V2AdapterRegistration = {
  id: "v2-plan-source",
  register: async ({ ctx, runtime }) => {
    try {
      const source = await createPlanSource(ctx as V2RuntimePluginContext & PlanSourceContext, runtime.engine, {
        signal: runtime.abort.signal,
      })
      runtime.planSource = source
      runtime.subscriptions?.push(source.subscription)
    } catch (error) {
      console.warn("[opencode-v2] registration failed")
      throw error
    }
  },
}

export const v2AdapterRegistrations: readonly V2AdapterRegistration[] = [
  v2EventAdapterRegistration,
  v2RequestHooksAdapterRegistration,
  v2ContextHookAdapterRegistration,
  v2PromptHookAdapterRegistration,
  v2ModelResolveAdapterRegistration,
  v2ToolHooksAdapterRegistration,
  v2CompactionHooksAdapterRegistration,
  v2IdleContinuationAdapterRegistration,
  v2PlanSourceAdapterRegistration,
  v2ProviderModelAdapterRegistration,
]
