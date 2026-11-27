// Armed-debounce window (the plan source's awaitable debounce seam). A
// *.updated listener arms one window per event burst; settle() awaits the
// window so the runtime can drain the startup recompute chain to a fixed
// point before the plugin reports active. fired resolves when the window
// elapses (the recompute is enqueued by onFire before waiters resume);
// cancel supersedes the window when a newer event re-arms.

import type { PlanSourceScheduler } from "./plan-source-context"

export type ArmedDebounce = {
  readonly fired: Promise<void>
  readonly cancel: () => void
}

export function armDebounceWindow(
  scheduler: PlanSourceScheduler,
  debounceMs: number,
  onFire: () => void,
): ArmedDebounce {
  let fire: () => void = () => undefined
  const fired = new Promise<void>((resolve) => {
    fire = resolve
  })
  const cancelHandle = scheduler.setTimeout(() => {
    fire()
    onFire()
  }, debounceMs)
  return {
    fired,
    cancel: () => {
      cancelHandle()
      fire()
    },
  }
}

export const defaultPlanScheduler: PlanSourceScheduler = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    return () => clearTimeout(handle)
  },
}

// The fixed-point drain the runtime runs before the plugin reports active.
// The reloads each startup recompute fires publish *.updated events whose
// debounced recomputes would otherwise land only AFTER setup returned, so
// the first admitted session could observe a mid-settlement plan (CI run
// 46070504361: scenario A's first request missed the patch and task tools
// until the post-activation recomputes settled). A round waits out one armed
// window and applies its recompute; a round that finds no armed window
// reached the fixed point. The drain never injects a recompute of its own:
// an idle source settles without touching the plan. The round cap bounds an
// endless event storm (live MCP reconnect churn): the plugin reports active
// on the drained prefix instead of never.
export async function drainArmedWindows(
  armedOf: () => ArmedDebounce | undefined,
  queueTail: () => Promise<void>,
  maxRounds: number,
): Promise<void> {
  for (let round = 0; round < maxRounds; round += 1) {
    const pending = armedOf()
    if (pending === undefined) break
    await pending.fired
    await queueTail()
  }
  await queueTail()
}
