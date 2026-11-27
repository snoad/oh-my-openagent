import { describe, expect, it } from "bun:test"

import { migrateToolsToPermission } from "../../shared/permission-compat"
import { createFakeV2Context } from "../parity/fake-v2-context"
import { createHostStateSnapshot } from "./host-state-snapshot"

// Proves the projection lets the V1 prompt rewrite (SRC/plugin-interface.ts
// config handler) produce the same tool-permission rules V1 produces for the
// same effective permissions. The hand-built V1 shapes are an independent
// derivation of the same synthetic host state.

const syntheticAgents = [
  {
    id: "explorer",
    name: "explorer",
    mode: "subagent" as const,
    hidden: false,
    permissions: [
      { action: "shell", resource: "*", effect: "allow" as const },
      { action: "webfetch", resource: "*", effect: "allow" as const },
      { action: "subagent", resource: "*", effect: "deny" as const },
      { action: "read", resource: "*.env", effect: "ask" as const },
    ],
  },
  {
    id: "planner",
    name: "planner",
    mode: "primary" as const,
    hidden: false,
    permissions: [
      { action: "edit", resource: "*", effect: "deny" as const },
      { action: "edit", resource: "/tmp/proj/*", effect: "allow" as const },
      { action: "mcp.use", resource: "*", effect: "ask" as const },
      { action: "skill.use", resource: "*", effect: "deny" as const },
    ],
  },
]

type RewriteRulesInput = {
  tools?: Record<string, boolean>
  permission?: Record<string, unknown>
  agent?: Record<string, { permission?: Record<string, unknown> }>
}

// Mirrors the rule collection of the V1 prompt rewrite in
// SRC/plugin-interface.ts:106-123 (config.tools, config.permission,
// agent.permission in that order).
function collectToolPermissionRules(config: RewriteRulesInput, agentName: string): Array<Record<string, string>> {
  const collected: Array<Record<string, string>> = []
  for (const [pattern, enabled] of Object.entries(config.tools ?? {})) {
    collected.push({ pattern, permission: enabled ? "allow" : "deny" })
  }
  const agent = config.agent?.[agentName]
  for (const permissions of [config.permission, agent?.permission]) {
    for (const [pattern, permission] of Object.entries(permissions ?? {})) {
      if (permission === "allow" || permission === "ask" || permission === "deny") {
        collected.push({ pattern, permission })
      } else if (typeof permission === "object" && permission !== null) {
        for (const [scope, action] of Object.entries(permission)) {
          if (action === "allow" || action === "ask" || action === "deny") {
            collected.push({ pattern, permission: action, scope })
          }
        }
      }
    }
  }
  return collected
}

describe("projection equals the hand-derived V1 shapes under the V1 rewrite", () => {
  it("#given the synthetic host state #when the snapshot builds #then the projection maps equal the hand-derived V1 tools and permission maps", async () => {
    // given
    const ctx = createFakeV2Context({ agents: syntheticAgents })
    const snapshot = createHostStateSnapshot(ctx)

    // when
    const projection = await snapshot.get()
    const handTools: Record<string, boolean> = {}
    for (const tool of await ctx.tool.list()) handTools[tool.id] = true
    const scopedEdit = { "*": "deny", "/tmp/proj/*": "allow" }
    Object.assign(handTools, {
      bash: true,
      webfetch: true,
      task: false,
      write: false,
      patch: false,
      "mcp.use": true,
      "skill.use": false,
    })
    const handPermission = {
      bash: "allow",
      webfetch: "allow",
      task: "deny",
      write: scopedEdit,
      patch: scopedEdit,
      "mcp.use": "ask",
      "skill.use": "deny",
    }

    // then
    expect(projection.tools).toEqual(handTools)
    expect(projection.permission).toEqual(handPermission)
    expect(projection.unmapped).toEqual(["read"])
  })

  it("#given the projection and the hand-derived V1 shapes #when the V1 rewrite collects rules #then both sides produce the same rules per agent", async () => {
    // given
    const ctx = createFakeV2Context({ agents: syntheticAgents })
    const snapshot = createHostStateSnapshot(ctx)
    const projection = await snapshot.get()
    const scopedEdit = { "*": "deny", "/tmp/proj/*": "allow" }
    const handConfig = {
      tools: Object.assign(Object.fromEntries((await ctx.tool.list()).map((tool) => [tool.id, true])), {
        bash: true,
        webfetch: true,
        task: false,
        write: false,
        patch: false,
        "mcp.use": true,
        "skill.use": false,
      }),
      permission: {
        bash: "allow",
        webfetch: "allow",
        task: "deny",
        write: scopedEdit,
        patch: scopedEdit,
        "mcp.use": "ask",
        "skill.use": "deny",
      },
      agent: {
        explorer: { permission: { bash: "allow", webfetch: "allow", task: "deny" } },
        planner: {
          permission: { write: scopedEdit, patch: scopedEdit, "mcp.use": "ask", "skill.use": "deny" },
        },
      },
    }

    // when
    const fromProjectionExplorer = collectToolPermissionRules(projection, "explorer")
    const fromHandExplorer = collectToolPermissionRules(handConfig, "explorer")
    const fromProjectionPlanner = collectToolPermissionRules(projection, "planner")
    const fromHandPlanner = collectToolPermissionRules(handConfig, "planner")

    // then
    expect(fromProjectionExplorer).toEqual(fromHandExplorer)
    expect(fromProjectionPlanner).toEqual(fromHandPlanner)
    expect(fromProjectionExplorer.some((rule) => rule.pattern === "bash" && rule.permission === "allow")).toBe(true)
    expect(fromProjectionPlanner.some((rule) => rule.pattern === "skill.use" && rule.permission === "deny")).toBe(true)
  })

  it("#given both tools maps #when the real V1 migrateToolsToPermission runs #then the normalized permission views are equal", async () => {
    // given
    const ctx = createFakeV2Context({ agents: syntheticAgents })
    const snapshot = createHostStateSnapshot(ctx)
    const projection = await snapshot.get()
    const handTools = Object.assign(Object.fromEntries((await ctx.tool.list()).map((tool) => [tool.id, true])), {
      bash: true,
      webfetch: true,
      task: false,
      write: false,
      patch: false,
      "mcp.use": true,
      "skill.use": false,
    })

    // when
    const fromProjection = migrateToolsToPermission(projection.tools)
    const fromHand = migrateToolsToPermission(handTools)

    // then
    expect(fromProjection).toEqual(fromHand)
    expect(fromProjection["task"]).toBe("deny")
    expect(fromProjection["bash"]).toBe("allow")
  })
})
