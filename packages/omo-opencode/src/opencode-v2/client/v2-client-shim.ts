import { createMiscMethods } from "./misc-methods"
import { createPromptMethods } from "./prompt-methods"
import { createSessionSnapshotCache } from "./session-snapshot-cache"
import { createSessionLifecycleMethods } from "./session-methods"
import type { V2ShimContext } from "./shim-context"
import type { V1ClientShimSurface } from "./v1-client-surface"

// createV2ClientShim (plan task 12): the OpenCode 2 ctx dressed as the V1
// client surface the engine calls. Every method routes to the pinned 2.4.1
// domains and answers in the V1 result envelope; the object satisfies the
// SDK-derived V1ClientShimSurface so the seam is type-checked. Unsupported
// access fails loudly: an unknown method on a supported domain throws at
// access time, an unknown domain answers a stub whose every call throws
// naming itself (feature probing stays safe).

export type V2ClientShimOptions = {
  readonly promptWaitPollMs?: number
  readonly log?: (message: string, detail?: unknown) => void
}

const DEFAULT_PROMPT_WAIT_POLL_MS = 200

function unsupportedError(label: string): Error {
  return new Error(`v2 client shim: ${label} is not supported by the OpenCode 2 client shim`)
}

function guardDomain<TDomain extends object>(domain: TDomain, domainName: string): TDomain {
  return new Proxy(domain, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver)
      throw unsupportedError(`${domainName}.${String(property)}`)
    },
  })
}

function unsupportedDomain(domainName: string): Record<string, () => never> {
  return new Proxy(
    {},
    {
      get(_target, property) {
        const label = `${domainName}.${String(property)}`
        return () => {
          throw unsupportedError(label)
        }
      },
    },
  )
}

function wrapUnsupportedDomains(supported: V1ClientShimSurface): V1ClientShimSurface {
  const domains = new Set<string>(Object.keys(supported))
  return new Proxy(supported, {
    has(_target, property) {
      return domains.has(String(property))
    },
    get(target, property, receiver) {
      if (domains.has(String(property))) return Reflect.get(target, property, receiver)
      return unsupportedDomain(String(property))
    },
  })
}

export function createV2ClientShim(ctx: V2ShimContext, options?: V2ClientShimOptions): V1ClientShimSurface {
  const cache = createSessionSnapshotCache()
  const log = options?.log ?? (() => {})
  const session = {
    ...createSessionLifecycleMethods(ctx, cache),
    ...createPromptMethods({ ctx, cache, waitPollMs: options?.promptWaitPollMs ?? DEFAULT_PROMPT_WAIT_POLL_MS }),
  } satisfies V1ClientShimSurface["session"]
  const supported = {
    session: guardDomain(session, "session"),
    ...createMiscMethods({ ctx, log }),
  } satisfies V1ClientShimSurface
  return wrapUnsupportedDomains(supported)
}
