import type { Agent as V1Agent, AgentConfig, Config as V1Config } from "@opencode-ai/sdk"
import type { V1ClientShimSurface } from "./v1-client-surface"
import { v1Success } from "./v1-client-surface"
import type { V2ShimAgentInfo, V2ShimContext } from "./shim-context"

// The non-session domains of the V2 client shim (plan task 12). tui.showToast
// is a log-only marker ([opencode-v2] toast) until plan task 36 switches it to
// the RPC channel; app.agents, provider.list and the cached config.get
// projection are built from ctx.agent.list()/ctx.tool.list() until plan task
// 22 replaces them with the host-state snapshot.

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

function agentConfigProjection(agent: V2ShimAgentInfo): AgentConfig {
  return {
    ...(agent.description === undefined ? {} : { description: agent.description }),
    mode: agent.mode,
  }
}

export type V2MiscMethodDeps = {
  readonly ctx: V2ShimContext
  readonly log: (message: string, detail?: unknown) => void
}

export function createMiscMethods(deps: V2MiscMethodDeps): Omit<V1ClientShimSurface, "session"> {
  const { ctx, log } = deps
  let configProjection: V1Config | undefined

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
        if (configProjection === undefined) {
          const [agents, tools] = await Promise.all([ctx.agent.list(), ctx.tool.list()])
          const agent: NonNullable<V1Config["agent"]> = {}
          for (const entry of agents.data) agent[entry.name] = agentConfigProjection(entry)
          const enabledTools: Record<string, boolean> = {}
          for (const tool of tools) enabledTools[tool.id] = true
          configProjection = { agent, tools: enabledTools, permission: {}, mcp: {}, command: {} }
        }
        return v1Success(configProjection, CONFIG_ROUTE)
      },
    },
  }
}
