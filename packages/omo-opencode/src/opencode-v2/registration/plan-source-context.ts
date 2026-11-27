// Structural ctx and engine slices the plan source consumes (task 23). The
// fake ctx (parity/fake-v2-context.ts), the real OpenCode 2 host ctx and the
// client shim ctx all satisfy them; the domain reload members come from the
// pinned 2.4.1 plugin surfaces (every domain carries reload(): Promise<void>).

import type { V2IncomingEvent } from "../events/v2-event-payload"
import type { SnapshotContext } from "./snapshot-inputs"
import type { V1WorkingConfig } from "./v1-config-projection"

export type PlanSourceDomain = {
  readonly reload: () => Promise<void>
}

export type PlanSourceContext = SnapshotContext & {
  readonly event: {
    readonly subscribe: (options?: {
      readonly types?: ReadonlyArray<string>
      readonly signal?: AbortSignal
    }) => AsyncIterable<V2IncomingEvent>
  }
  readonly agent: PlanSourceDomain
  readonly tool: PlanSourceDomain
  readonly mcp: PlanSourceDomain
  readonly command: PlanSourceDomain
  readonly provider: PlanSourceDomain
  readonly model: PlanSourceDomain
}

// The engine hooks slice carrying the REAL V1 config handler
// (SRC/plugin-interface.ts config member, the six-phase pipeline plus the
// agent prompt rewrite).
export type PlanSourceEngine = {
  readonly config?: (config: V1WorkingConfig) => Promise<void> | void
}

// Debounce seam: the fake ctx scheduler, a manual test scheduler and the real
// setTimeout all satisfy it. setTimeout returns the cancel function.
export type PlanSourceScheduler = {
  readonly setTimeout: (callback: () => void, ms: number) => () => void
}
