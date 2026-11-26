import { v2SubscriptionTypes } from "./v1-event-catalog"
import { createSnapshotStore, type SnapshotScheduler, type SnapshotStoreContext } from "./snapshot-store"
import type { V1OutEvent } from "./v1-out-event"
import { translate } from "./v2-to-v1-events"
import type { V2IncomingEvent } from "./v2-event-payload"

// Subscription loop (plan task 14): subscribes to every catalog source on
// the OpenCode 2 event stream, translates each event and awaits the V1
// delivery for every result inside try/catch error isolation (a failing V1
// handler or translation is logged and skipped, the loop continues).
// stop() aborts the subscription, awaits loop completion through an
// injectable timeout and cancels the pending snapshot refreshes.

export type V2EventSubscriptionContext = SnapshotStoreContext & {
  readonly event: {
    readonly subscribe: (options?: {
      readonly types?: ReadonlyArray<string>
      readonly signal?: AbortSignal
    }) => AsyncIterable<V2IncomingEvent>
  }
}

export type V1EventDelivery = { readonly event: V1OutEvent }

export type SubscribeV2EventsOptions = {
  readonly debug?: (message: string) => void
  readonly scheduler?: SnapshotScheduler
  readonly signal?: AbortSignal
  readonly stopTimeoutMs?: number
}

export type V2EventSubscription = {
  readonly stop: () => Promise<void>
}

const DEFAULT_STOP_TIMEOUT_MS = 2000

export function subscribeV2Events(
  ctx: V2EventSubscriptionContext,
  onV1Event: (input: V1EventDelivery) => void | Promise<void>,
  options: SubscribeV2EventsOptions = {},
): V2EventSubscription {
  const debug = options.debug ?? defaultDebug
  const controller = new AbortController()
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true })
  const deliverEvent = async (event: V1OutEvent): Promise<void> => {
    try {
      await onV1Event({ event })
    } catch (error) {
      debug(`[v2-events] v1 handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const store = createSnapshotStore({
    ctx,
    onEvents: async (events) => {
      for (const event of events) await deliverEvent(event)
    },
    scheduler: options.scheduler,
    debug,
  })
  const iteration = ctx.event.subscribe({ types: v2SubscriptionTypes(), signal: controller.signal })
  const loopDone = runLoop(iteration, store, deliverEvent, debug)
  return {
    stop: async () => {
      controller.abort()
      await withTimeout(loopDone, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS, debug)
      store.dispose()
    },
  }
}

async function runLoop(
  iteration: AsyncIterable<V2IncomingEvent>,
  store: ReturnType<typeof createSnapshotStore>,
  deliverEvent: (event: V1OutEvent) => Promise<void>,
  debug: (message: string) => void,
): Promise<void> {
  try {
    for await (const v2Event of iteration) {
      let translated: V1OutEvent[]
      try {
        translated = translate(v2Event, store)
      } catch (error) {
        debug(
          `[v2-events] translation failed for ${v2Event.type}: ${error instanceof Error ? error.message : String(error)}`,
        )
        continue
      }
      for (const event of translated) await deliverEvent(event)
    }
  } catch (error) {
    debug(`[v2-events] subscription loop failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function withTimeout(promise: Promise<void>, ms: number, debug: (message: string) => void): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`subscription loop did not stop within ${ms}ms`)), ms)
      }),
    ])
  } catch (error) {
    debug(`[v2-events] stop: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function defaultDebug(message: string): void {
  console.debug(`[opencode-v2] ${message}`)
}
