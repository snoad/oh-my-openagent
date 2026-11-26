import type { V2Runtime } from "./stop-v2-runtime"
import type { V2RuntimePluginContext } from "./start-v2-runtime"

// Ordered adapter registration list (plan task 13). The runtime applies every
// registration in order after the engine started, passing the ctx and the
// runtime record (engine hooks, abort signal). The list is empty in task 13;
// tasks 15 to 19 and 22 to 28 append their registrations here, so a later
// wave only adds entries and never touches startV2Runtime again.

export type V2AdapterRegistration = {
  readonly id: string
  readonly register: (input: {
    readonly ctx: V2RuntimePluginContext
    readonly runtime: V2Runtime
  }) => void | Promise<void>
}

export const v2AdapterRegistrations: readonly V2AdapterRegistration[] = []
