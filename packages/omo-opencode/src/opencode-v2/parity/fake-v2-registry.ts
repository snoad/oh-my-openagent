// Hook, transform and event substrate for the fake OpenCode 2 plugin context
// (task 9 of the opencode-v2-compat plan). Shapes mirror the pinned
// node_modules/@opencode/plugin 2.4.1 declarations: a registration is
// { dispose } (registration.d.ts), hooks run in registration order and a
// rejection aborts the run (hook semantics recorded in the plan), transforms
// are synchronous callbacks over one mutable value, and event subscriptions
// are async iterables filtered by type and aborted through their signal.

export type FakeRegistration = { readonly dispose: () => Promise<void> }

export type FakeHookOptions = { readonly providerID?: string }

export type FakeScheduler = {
  now: () => number
  setTimeout: (callback: () => void, ms: number) => () => void
}

export type FakeV2Event = {
  readonly type: string
  readonly [key: string]: unknown
}

export type FakeSubscribeOptions = {
  readonly types?: ReadonlyArray<string>
  readonly signal?: AbortSignal
  readonly onActivity?: () => void
}

// The never parameter is the bottom-type storage idiom: every callback shape
// (SDK-typed or local mirror) is assignable to (input: never) => ..., which is
// how one registry stores heterogeneous hook callbacks without any.
type StoredHook = (input: never) => void | Promise<void>
type StoredTransform = (value: never) => void

type HookEntry = {
  readonly domain: string
  readonly name: string
  readonly callback: StoredHook
  readonly options?: FakeHookOptions
}

type TransformEntry = {
  readonly domain: string
  readonly callback: StoredTransform
}

// Hook and transform capture shared by every fake domain. `fire` awaits each
// matching callback in registration order; the first rejection propagates and
// the remaining callbacks do not run. A provider-scoped registration fires
// whenever the fire options do not name a different provider.
export type FakeHookRegistry = {
  readonly registerHook: (
    domain: string,
    name: string,
    callback: StoredHook,
    options?: FakeHookOptions,
  ) => FakeRegistration
  readonly fire: <TEvent>(domain: string, name: string, event: TEvent, options?: FakeHookOptions) => Promise<TEvent>
  readonly registerTransform: (domain: string, callback: StoredTransform) => FakeRegistration
  readonly replayTransforms: <TValue>(domain: string, fresh: TValue) => TValue
}

export function createHookRegistry(): FakeHookRegistry {
  const hooks: HookEntry[] = []
  const transforms: TransformEntry[] = []

  const registerHook: FakeHookRegistry["registerHook"] = (domain, name, callback, options) => {
    const entry: HookEntry = { domain, name, callback, options }
    hooks.push(entry)
    return {
      dispose: async () => {
        const index = hooks.indexOf(entry)
        if (index >= 0) hooks.splice(index, 1)
      },
    }
  }

  const fire: FakeHookRegistry["fire"] = async (domain, name, event, options) => {
    for (const entry of [...hooks]) {
      if (entry.domain !== domain || entry.name !== name) continue
      const scoped = entry.options?.providerID
      if (scoped !== undefined && options?.providerID !== undefined && scoped !== options.providerID) continue
      await entry.callback(event as never)
    }
    return event
  }

  const registerTransform: FakeHookRegistry["registerTransform"] = (domain, callback) => {
    const entry: TransformEntry = { domain, callback }
    transforms.push(entry)
    return {
      dispose: async () => {
        const index = transforms.indexOf(entry)
        if (index >= 0) transforms.splice(index, 1)
      },
    }
  }

  const replayTransforms: FakeHookRegistry["replayTransforms"] = (domain, fresh) => {
    for (const entry of [...transforms]) {
      if (entry.domain === domain) entry.callback(fresh as never)
    }
    return fresh
  }

  return { registerHook, fire, registerTransform, replayTransforms }
}

type Subscriber = {
  readonly types?: ReadonlySet<string>
  readonly signal?: AbortSignal
  readonly onActivity?: () => void
  readonly queue: FakeV2Event[]
  resolve: ((result: IteratorResult<FakeV2Event>) => void) | undefined
  active: boolean
}

// Event fan-out behind ctx.event.subscribe and __pushEvent. Every active
// iterator whose type filter matches the pushed event receives it; a queued
// event wakes a parked next(), and aborting the signal ends the iteration.
export type FakeEventStream = {
  readonly subscribe: (options?: FakeSubscribeOptions) => AsyncIterable<FakeV2Event>
  readonly push: (event: FakeV2Event) => void
}

export function createEventStream(): FakeEventStream {
  const subscribers: Subscriber[] = []

  const settle = (subscriber: Subscriber, result: IteratorResult<FakeV2Event>): void => {
    const resolve = subscriber.resolve
    subscriber.resolve = undefined
    resolve?.(result)
  }

  const deactivate = (subscriber: Subscriber): void => {
    if (!subscriber.active) return
    subscriber.active = false
    const index = subscribers.indexOf(subscriber)
    if (index >= 0) subscribers.splice(index, 1)
    settle(subscriber, { value: undefined, done: true })
  }

  const next = (subscriber: Subscriber): Promise<IteratorResult<FakeV2Event>> => {
    const queued = subscriber.queue.shift()
    if (queued !== undefined) return Promise.resolve({ value: queued, done: false })
    if (!subscriber.active) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => {
      subscriber.resolve = resolve
    })
  }

  const push = (event: FakeV2Event): void => {
    for (const subscriber of [...subscribers]) {
      if (!subscriber.active) continue
      if (subscriber.types && !subscriber.types.has(event.type)) continue
      subscriber.onActivity?.()
      if (subscriber.resolve) {
        settle(subscriber, { value: event, done: false })
      } else {
        subscriber.queue.push(event)
      }
    }
  }

  const subscribe = (options?: FakeSubscribeOptions): AsyncIterable<FakeV2Event> => {
    const subscriber: Subscriber = {
      types: options?.types ? new Set(options.types) : undefined,
      signal: options?.signal,
      onActivity: options?.onActivity,
      queue: [],
      resolve: undefined,
      active: true,
    }
    subscriber.signal?.addEventListener("abort", () => deactivate(subscriber))
    subscribers.push(subscriber)
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => next(subscriber),
        return: async () => (deactivate(subscriber), { value: undefined, done: true }),
        throw: async (reason: unknown) => {
          deactivate(subscriber)
          throw reason
        },
      }),
    }
  }

  return { subscribe, push }
}

export function createDefaultScheduler(): FakeScheduler {
  return {
    now: () => Date.now(),
    setTimeout: (callback, ms) => {
      const handle = setTimeout(callback, ms)
      return () => clearTimeout(handle)
    },
  }
}
