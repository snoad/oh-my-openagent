import { registerTodoTools, type TodoToolEditor } from "../registration/todo-tools"
import type { V2Runtime } from "./stop-v2-runtime"
import type { V2RuntimePluginContext } from "./start-v2-runtime"

// Plan task 29: the plugin todo tools register once at adapter time (they are
// not config-driven, so no plan-source recompute step is needed). The static
// shim ctx slice omits session.update and the host tool transform, so the
// registration narrows the ctx to the update-capable view at this one
// boundary (the real host SessionDomain carries update, the tool domain
// carries transform, and the hermetic fake implements both).

type V2TodoSessionContext = V2RuntimePluginContext & {
  readonly session: V2RuntimePluginContext["session"] & {
    readonly update: (input: {
      readonly sessionID: string
      readonly metadata?: Record<string, unknown>
    }) => Promise<void>
  }
  readonly tool: V2RuntimePluginContext["tool"] & {
    readonly list: () => Promise<ReadonlyArray<{ readonly id: string }>>
    readonly transform: (callback: (editor: TodoToolEditor) => void) => Promise<unknown>
  }
}

const v2TodoAdapterRegistration = {
  id: "v2-todo-registration",
  register: ({ ctx, runtime }: { readonly ctx: V2RuntimePluginContext; readonly runtime: V2Runtime }) => {
    const planSource = runtime.planSource
    if (planSource === undefined) throw new Error("[opencode-v2] todo registration: plan source missing")
    registerTodoTools(ctx as V2TodoSessionContext, planSource)
  },
}

export const v2TodoAdapter = v2TodoAdapterRegistration
