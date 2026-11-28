import type { Agent as V1Agent } from "@opencode-ai/sdk"
import type { V1ClientShimSurface } from "./v1-client-surface"
import { v1Success } from "./v1-client-surface"
import type { V2ShimAgentInfo, V2ShimContext } from "./shim-context"
import { createHostStateSnapshot } from "../registration/host-state-snapshot"
import type { V1ConfigProjection } from "../registration/v1-config-projection"

// The non-session domains of the V2 client shim (plan task 12). tui.showToast
// is a log-only marker ([opencode-v2] toast) until plan task 36 switches it to
// the RPC channel; app.agents and provider.list are built from ctx reads,
// config.get is served by the host-state snapshot (plan task 22).

const TOAST_ROUTE = "/tui/show-toast"
const AGENTS_ROUTE = "/agent"
const PROVIDER_ROUTE = "/provider"
const CONFIG_ROUTE = "/config"
const TOAST_LOG_MARKER = "[opencode-v2] toast"

type EditEffect = "ask" | "allow" | "deny"

function editEffectOf(agent: V2ShimAgentInfo): EditEffect {
  const rules = agent.permissions ?? []
  const edit = rules.find((rule) => rule.action === "edit")
  if (edit !== undefined) return edit.effect
  const wildcard = rules.find((rule) => rule.action === "*")
  if (wildcard !== undefined) return wildcard.effect
  return "ask"
}

function toV1Agent(agent: V2ShimAgentInfo): V1Agent {
  return {
    name: agent.name,
    mode: agent.mode,
    builtIn: false,
    permission: { edit: editEffectOf(agent), bash: {} },
    tools: {},
    options: {},
    ...(agent.description === undefined ? {} : { description: agent.description }),
  }
}

export type V2MiscMethodDeps = {
  readonly ctx: V2ShimContext
  readonly log: (message: string, detail?: unknown) => void
}

export function createMiscMethods(deps: V2MiscMethodDeps): Omit<V1ClientShimSurface, "session"> {
  const { ctx, log } = deps
  const configSnapshot = createHostStateSnapshot(ctx)

  return {
    tui: {
      async showToast(options) {
        log(TOAST_LOG_MARKER, options?.body)
        return v1Success(true, TOAST_ROUTE)
      },
    },

    app: {
      async agents() {
        const response = await ctx.agent.list()
        return v1Success(response.data.map(toV1Agent), AGENTS_ROUTE)
      },
    },

    provider: {
      async list() {
        const response = await ctx.provider.list()
        return v1Success(
          {
            all: response.data.map((provider) => ({ id: provider.id, name: provider.name, env: [], models: {} })),
            default: {},
            connected: [],
          },
          PROVIDER_ROUTE,
        )
      },
    },

    config: {
      async get() {
        const projection: V1ConfigProjection = await configSnapshot.get()
        return v1Success(projection, CONFIG_ROUTE)
      },
    },
  }
}
