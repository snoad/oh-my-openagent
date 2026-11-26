// Rpc and storage domains for the fake OpenCode 2 plugin context (task 9 of the opencode-v2-compat plan,
// split out of fake-v2-support-domains.ts). Local structural mirrors of the pinned
// node_modules/@opencode/plugin 2.4.1 declarations: rpc dispatches call() to registered handlers, and
// storage is a map with the SDK scan semantics (prefix + after cursor + limit).

import type { FakeHookRegistry, FakeRegistration, FakeV2Event } from "./fake-v2-registry"

export type FakeJsonValue = null | boolean | number | string | FakeJsonValue[] | { [key: string]: FakeJsonValue }

export type FakeRpcDefinition = {
  id: string
  methods?: Record<string, unknown>
  events?: Record<string, unknown>
}

export type FakeRpcCallContext = {
  signal: AbortSignal
  error: (message: string) => FakeRpcError
}

export type FakeRpcError = { readonly data: { readonly message: string } }

export type FakeRpcHandlers = Record<string, (input: unknown, context: FakeRpcCallContext) => Promise<unknown>>

export interface FakeRpcDomain {
  call(input: { rpcID: string; method: string; input?: unknown }): Promise<{ output?: unknown }>
  register(
    definition: FakeRpcDefinition,
    handlers: FakeRpcHandlers,
  ): Promise<FakeRegistration & { events: { emit: (name: string, data: unknown) => Promise<void> } }>
}

export interface FakeStorageDomain {
  get(key: string): Promise<FakeJsonValue | undefined>
  set(key: string, value: FakeJsonValue): Promise<void>
  remove(key: string): Promise<void>
  scan(options: {
    prefix: string
    after?: string
    limit?: number
  }): Promise<{ entries: Array<{ key: string; value: FakeJsonValue }>; next?: string }>
}

export function createRpcDomain(input: {
  readonly registry: FakeHookRegistry
  readonly stream: { readonly push: (event: FakeV2Event) => void }
}): FakeRpcDomain {
  const registrations = new Map<string, FakeRpcHandlers>()
  return {
    async call(callInput) {
      const handlers = registrations.get(callInput.rpcID)
      const handler = handlers?.[callInput.method]
      if (!handler) throw new Error(`fake v2: no rpc handler ${callInput.rpcID}.${callInput.method}`)
      const output = await handler(callInput.input, {
        signal: new AbortController().signal,
        error: (message: string) => ({ data: { message } }),
      })
      return { output }
    },
    async register(definition, handlers) {
      registrations.set(definition.id, handlers)
      return {
        dispose: async () => void registrations.delete(definition.id),
        events: {
          emit: async (name: string, data: unknown) => input.stream.push({ type: `rpc.${name}`, data }),
        },
      }
    },
  }
}

export function createStorageDomain(storage: Map<string, FakeJsonValue>): FakeStorageDomain {
  return {
    async get(key) {
      return storage.get(key)
    },
    async set(key, value) {
      storage.set(key, value)
    },
    async remove(key) {
      storage.delete(key)
    },
    async scan(scanInput) {
      const keys = [...storage.keys()]
        .filter((key) => key.startsWith(scanInput.prefix) && (scanInput.after === undefined || key > scanInput.after))
        .sort()
      const limit = scanInput.limit ?? keys.length
      const page = keys.slice(0, limit)
      const next = keys.length > limit ? page[page.length - 1] : undefined
      return { entries: page.map((key) => ({ key, value: storage.get(key) as FakeJsonValue })), next }
    },
  }
}
