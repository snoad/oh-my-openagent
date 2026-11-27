import type { V2EngineHooks } from "./start-v2-runtime"
import { activeV2Runtimes, releaseV2ProcessDep, type V2RuntimeTracker } from "./v2-runtime-deps"

// stopV2Runtime (plan task 13): the cleanup half of the OpenCode 2 runtime.
// Aborts the runtime subscriptions, releases the process-wide dependencies
// this runtime acquired, awaits the engine's own dispose (whose wrapped
// shared handles close only at the final release), and clears the
// active-runtime entry. Safe to call twice: the first call runs everything,
// the second is a no-op, so dispose runs exactly once.

export type V2Runtime = {
  readonly directory: string
  readonly engine: V2EngineHooks
  readonly tracker: V2RuntimeTracker
  readonly abort: AbortController
  // The event subscriptions the adapters registered; stop() awaits each one
  // so their per-subscription cleanup (the L-11/L-24 stats line) runs on
  // runtime stop, not only when a host invokes the plugin cleanup. Optional:
  // the parity row harnesses hand-build runtime records without it.
  readonly subscriptions?: Array<{ readonly stop: () => Promise<void> }>
  readonly stop: () => Promise<void>
  stopped: boolean
}

export async function stopV2Runtime(runtime: V2Runtime): Promise<void> {
  if (runtime.stopped) return
  runtime.stopped = true
  if (activeV2Runtimes.get(runtime.directory) === runtime) {
    activeV2Runtimes.delete(runtime.directory)
  }
  runtime.abort.abort()
  for (const subscription of runtime.subscriptions ?? []) {
    await subscription.stop()
  }
  for (const name of runtime.tracker.releasedDeps) {
    await releaseV2ProcessDep(name)
  }
  await runtime.engine.dispose?.()
  for (const handle of runtime.tracker.sharedHandles) {
    await handle.release()
  }
}
