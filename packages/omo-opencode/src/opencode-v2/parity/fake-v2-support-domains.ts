// Plugin, permission, shell, rpc and storage domains for the fake OpenCode 2
// plugin context, task 9 of the opencode-v2-compat plan. Local structural
// mirrors of the pinned node_modules/@opencode/plugin 2.4.1 declarations:
// plugin.list serves the {location, data} envelope, permission fires the
// evaluate hook on assert and rejects on deny, shell is hook-only, rpc
// dispatches call() to registered handlers, and storage is a map with the
// SDK scan semantics (prefix + after cursor + limit).

import type { FakeListEnvelope } from "./fake-v2-editors"
import type { FakeHookRegistry, FakeRegistration, FakeV2Event } from "./fake-v2-registry"

export type FakePluginInfo = {
  id?: string
  source: { type: "builtin" } | { type: "package"; target: string; version?: string } | { type: "local"; path: string } | { type: "sdk" }
  features?: { server?: true; tui?: true; rpc?: true; gui?: true }
  state?: { status: "active" } | { status: "failed"; error: string }
}

export interface FakePluginDomain {
  list(input?: { readonly location?: { readonly directory?: string } }): Promise<FakeListEnvelope<FakePluginInfo>>
}

export type FakePermissionRequest = {
  id: string
  sessionID: string
  action: string
  resources: string[]
  save?: string[]
  metadata?: Record<string, unknown>
  message?: string
}

export type FakePermissionEvaluation = {
  sessionID: string
  agent?: string
  action: string
  resources: string[]
  metadata?: Record<string, unknown>
  effect: "allow" | "deny" | "ask"
  message?: string
}

export type FakePermissionReply = "once" | "always" | "reject"

export interface FakePermissionDomain {
  list(input: { readonly sessionID: string }): Promise<FakePermissionRequest[]>
  get(input: { readonly requestID: string }): Promise<FakePermissionRequest>
  reply(input: { readonly requestID: string; readonly response: FakePermissionReply }): Promise<void>
  assert(input: { sessionID: string; agent?: string; action: string; resources: string[]; metadata?: Record<string, unknown> }): Promise<void>
  hook<TEvent extends object>(name: string, callback: (input: TEvent) => void | Promise<void>): Promise<FakeRegistration>
}

export interface FakeShellDomain {
  hook<TEvent extends object>(name: string, callback: (input: TEvent) => void | Promise<void>): Promise<FakeRegistration>
}

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
  register(definition: FakeRpcDefinition, handlers: FakeRpcHandlers): Promise<FakeRegistration & { events: { emit: (name: string, data: unknown) => Promise<void> } }>
}

export type FakeJsonValue = null | boolean | number | string | FakeJsonValue[] | { [key: string]: FakeJsonValue }

export interface FakeStorageDomain {
  get(key: string): Promise<FakeJsonValue | undefined>
  set(key: string, value: FakeJsonValue): Promise<void>
  remove(key: string): Promise<void>
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{ entries: Array<{ key: string; value: FakeJsonValue }>; next?: string }>
}

export function createPluginDomain(input: {
  readonly directory: string
  readonly plugins?: ReadonlyArray<FakePluginInfo>
}): FakePluginDomain {
  const plugins = input.plugins ?? [
    {
      id: "oh-my-openagent",
      source: { type: "local", path: input.directory },
      features: { server: true },
      state: { status: "active" },
    },
  ]
  return {
    async list() {
      return { location: { directory: input.directory }, data: [...plugins] }
    },
  }
}

export function createPermissionDomain(input: {
  readonly registry: FakeHookRegistry
  readonly requests?: ReadonlyArray<FakePermissionRequest>
}): FakePermissionDomain {
  const requests = new Map<string, FakePermissionRequest>((input.requests ?? []).map((request) => [request.id, { ...request }]))
  const replies = new Map<string, FakePermissionReply>()
  return {
    async list(listInput) {
      return [...requests.values()].filter((request) => request.sessionID === listInput.sessionID)
    },
    async get(getInput) {
      const request = requests.get(getInput.requestID)
      if (!request) throw new Error(`fake v2: unknown permission request ${getInput.requestID}`)
      return request
    },
    async reply(replyInput) {
      if (!requests.has(replyInput.requestID)) {
        throw new Error(`fake v2: unknown permission request ${replyInput.requestID}`)
      }
      replies.set(replyInput.requestID, replyInput.response)
    },
    async assert(assertInput) {
      const evaluation: FakePermissionEvaluation = { ...assertInput, effect: "ask" }
      await input.registry.fire("permission", "evaluate", evaluation)
      if (evaluation.effect === "deny") {
        throw new Error(evaluation.message ?? `fake v2: permission denied for ${assertInput.action}`)
      }
    },
    async hook(name, callback) {
      return input.registry.registerHook("permission", name, callback)
    },
  }
}

export function createShellDomain(input: { readonly registry: FakeHookRegistry }): FakeShellDomain {
  return {
    async hook(name, callback) {
      return input.registry.registerHook("shell", name, callback)
    },
  }
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
        dispose: async () => {
          registrations.delete(definition.id)
        },
        events: {
          emit: async (name: string, data: unknown) => {
            input.stream.push({ type: `rpc.${name}`, data })
          },
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
