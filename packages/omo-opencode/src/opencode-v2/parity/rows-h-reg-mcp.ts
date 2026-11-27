import { expect } from "./bun-test-shim"

import { registerMcpTransform, type McpRegistrationEditor } from "../registration/mcp"
import { createPlanSource, type PlanSource } from "../registration/plan-source"
import { createFakeV2Context, type FakeV2Context } from "./fake-v2-context"
import { defineGroup, type ParityRow } from "./rows"

// Wave-3 H-REG MCP rows (plan task 26): every V1 config variant maps onto the
// pinned OpenCode 2 definition, the registered set equals the V1 pipeline
// output on the same base, replay is idempotent and the recorded
// pre-transform value survives a reload-triggered recompute without a ctx
// re-read, and an entry the V2 union cannot express is skipped through the
// reporter while the other servers still register.

async function planSourceWithMcp(
  ctx: FakeV2Context,
  seed: (config: { mcp?: Record<string, unknown> }) => void,
): Promise<PlanSource> {
  return createPlanSource(
    ctx,
    {
      config: async (config) => {
        seed(config as { mcp?: Record<string, unknown> })
      },
    },
    {},
  )
}

async function serverList(ctx: FakeV2Context): Promise<Map<string, Record<string, unknown>>> {
  const servers = new Map<string, Record<string, unknown>>()
  await ctx.mcp.transform((editor: McpRegistrationEditor) => {
    for (const [name, config] of editor.list()) servers.set(name, { ...config })
  })
  return servers
}

async function checkMcpTiers(): Promise<void> {
  const ctx = createFakeV2Context()
  const source = await planSourceWithMcp(ctx, (config) => {
    config["mcp"] = {
      websearch: {
        type: "remote",
        url: "https://mcp.exa.ai/mcp",
        enabled: true,
        headers: { Authorization: "Bearer e" },
        oauth: false,
      },
      lsp: {
        type: "local",
        command: ["node", "packages/lsp-daemon/dist/cli.js", "mcp"],
        enabled: true,
        cwd: "/repo",
        environment: { LSP_TOOLS_MCP_CWD: "/repo" },
      },
      "cc-probe": { type: "local", command: "node", args: ["-v"], env: { PROBE_TOKEN: "expanded-secret" } },
      "user-off": { type: "remote", url: "https://user.example", enabled: false },
    }
  })
  try {
    const step = registerMcpTransform(ctx, source.getPlan, source.snapshot)
    source.registerStep(step)
    await source.recompute()
    await source.idle()
    const plan = source.getPlan()
    const servers = await serverList(ctx)
    const planNames = [...Object.keys(plan?.mcp.added ?? {}), ...Object.keys(plan?.mcp.modified ?? {})].sort()
    expect([...servers.keys()].sort()).toEqual(planNames)
    expect(servers.get("websearch")).toEqual({
      type: "remote",
      url: "https://mcp.exa.ai/mcp",
      headers: { Authorization: "Bearer e" },
      oauth: false,
    })
    expect(servers.get("lsp")).toEqual({
      type: "local",
      command: ["node", "packages/lsp-daemon/dist/cli.js", "mcp"],
      cwd: "/repo",
      environment: { LSP_TOOLS_MCP_CWD: "/repo" },
    })
    expect(servers.get("cc-probe")).toEqual({
      type: "local",
      command: ["node", "-v"],
      environment: { PROBE_TOKEN: "expanded-secret" },
    })
    expect(servers.get("user-off")).toEqual({ type: "remote", url: "https://user.example", disabled: true })
    expect(servers.get("user-off") && "enabled" in (servers.get("user-off") as Record<string, unknown>)).toBe(false)
  } finally {
    await source.subscription.stop()
  }
}

async function checkMcpReplaySettles(): Promise<void> {
  const ctx = createFakeV2Context()
  const source = await planSourceWithMcp(ctx, (config) => {
    config["mcp"] = { websearch: { type: "remote", url: "https://mcp.exa.ai/mcp", enabled: true, oauth: false } }
  })
  try {
    const step = registerMcpTransform(ctx, source.getPlan, source.snapshot)
    source.registerStep(step)
    await source.recompute()
    await source.idle()
    const afterFirst = await serverList(ctx)
    const listCount = (): number => ctx.__calls.filter((call) => call.op === "mcp.list").length
    const listAfterFirst = listCount()
    for (let round = 0; round < 3; round += 1) {
      await source.recompute()
      await source.idle()
    }
    expect(await serverList(ctx)).toEqual(afterFirst)
    expect(listCount()).toBe(listAfterFirst)
    const base = await source.snapshot.get()
    expect(Object.keys(base.mcp)).toEqual(["websearch"])
  } finally {
    await source.subscription.stop()
  }
}

async function checkMcpUnsupportedSkipped(): Promise<void> {
  const ctx = createFakeV2Context()
  const source = await planSourceWithMcp(ctx, (config) => {
    config["mcp"] = {
      "ok-probe": { type: "local", command: ["node", "-v"], enabled: true },
      "docker-probe": { type: "docker", image: "mcp" },
    }
  })
  const reported: string[] = []
  try {
    const step = registerMcpTransform(ctx, source.getPlan, source.snapshot, {
      onUnsupportedEntry: (entry) => reported.push(entry),
    })
    source.registerStep(step)
    await source.recompute()
    await source.idle()
    const servers = await serverList(ctx)
    expect([...servers.keys()]).toEqual(["ok-probe"])
    expect(reported).toEqual(["docker-probe"])
    expect((source.getPlan()?.mcp.added ?? {})["docker-probe"]).toBeDefined()
  } finally {
    await source.subscription.stop()
  }
}

export const hRegMcpRows: ParityRow[] = defineGroup("H-REG", [
  {
    suffix: "MCP-TIERS",
    title:
      "every V1 mcp config variant maps onto the pinned OpenCode 2 definition and the registered set equals the pipeline output",
    kind: "hermetic",
    is: ["IS-6"],
    wave: 3,
    status: "checked",
    check: checkMcpTiers,
  },
  {
    suffix: "MCP-REPLAY",
    title:
      "replay is idempotent and the recorded pre-transform value survives a reload-triggered recompute without a ctx re-read",
    kind: "hermetic",
    is: ["IS-6"],
    wave: 3,
    status: "checked",
    check: checkMcpReplaySettles,
  },
  {
    suffix: "MCP-UNSUPPORTED-SKIP",
    title:
      "an entry with no OpenCode 2 counterpart is skipped with one report naming the server while the other servers still register",
    kind: "hermetic",
    is: ["IS-6"],
    wave: 3,
    status: "checked",
    check: checkMcpUnsupportedSkipped,
  },
])
