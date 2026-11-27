import { expect } from "./bun-test-shim"

import { createHostStateSnapshot } from "../registration/host-state-snapshot"
import { mapMcpListEntries, mapMcpServerConfig } from "../registration/mcp-command-mapping"
import { permissionRulesToV1 } from "../registration/permission-rules"
import { createFakeV2Context } from "./fake-v2-context"
import { callOps, rowSetup } from "./rows-h-client"
import { defineGroup, type ParityRow } from "./rows"

// Wave-3 H-REG base-snapshot rows (plan task 22): the host state snapshot as
// the V1 base config. Every check drives the real snapshot and mapping
// functions over the fixture-backed fake ctx (fixtures host-2.4.1/agents.json
// and tools.json).

async function checkAgents(): Promise<void> {
  const ctx = createFakeV2Context()
  const snapshot = createHostStateSnapshot(ctx)
  const projection = await snapshot.get()
  expect(Object.keys(projection.agent)).toContain("build")
  expect(Object.keys(projection.agent)).toContain("explore")
  expect(projection.agent["explore"]?.mode).toBe("subagent")
  const planConfig = projection.agent["plan"]
  expect(planConfig?.tools?.["write"]).toBe(false)
  await ctx.agent.transform((editor) => {
    snapshot.record({ domain: "agent", value: { agents: editor.list() } })
    editor.add({ id: "late-row-agent", name: "LateRowAgent", mode: "subagent", hidden: false })
  })
  await snapshot.refresh()
  expect(callOps(ctx, "agent.list")).toBe(1)
  expect(projection.agent["late-row-agent"]).toBeUndefined()
  const refreshed = await snapshot.get()
  expect(refreshed.agent["late-row-agent"]).toBeUndefined()
}

async function checkPermissions(): Promise<void> {
  const ctx = createFakeV2Context()
  const agents = (await ctx.agent.list()).data
  const logs: string[] = []
  const mapped = permissionRulesToV1(
    agents.flatMap((agent) => agent.permissions ?? []),
    (action) => logs.push(action),
  )
  expect(mapped.tools["bash"]).toBe(true)
  expect(mapped.tools["task"]).toBe(false)
  expect(mapped.permission["bash"]).toBe("allow")
  expect(mapped.permission["task"]).toBe("deny")
  expect(mapped.permission["write"]).toEqual({
    "*": "deny",
    "/tmp/oqa-v2-sandbox.5Lvyln/home/.opencode/plan/*": "allow",
  })
  expect(mapped.unmapped).toContain("read")
  expect(mapped.unmapped).toContain("browser")
  expect(mapped.unmapped).toContain("*")
  expect(logs.length).toBe(mapped.unmapped.length)
}

async function checkMcp(): Promise<void> {
  const local = mapMcpServerConfig("lsp", { type: "local", command: ["bun", "run", "lsp"], enabled: false })
  expect(local).toEqual({ type: "local", command: ["bun", "run", "lsp"], enabled: false })
  const remote = mapMcpServerConfig("context7", { type: "remote", url: "https://mcp.context7.com/mcp" })
  expect(remote).toEqual({ type: "remote", url: "https://mcp.context7.com/mcp" })
  const stubs = mapMcpListEntries([
    { name: "websearch", status: "connected" },
    { name: "lsp", status: "connected" },
  ])
  expect(stubs["websearch"]).toEqual({ type: "remote", url: "", enabled: false })
  expect(() => mapMcpServerConfig("broken", { type: "remote" })).toThrow(/broken/)
}

async function checkShim(): Promise<void> {
  const { ctx, shim } = rowSetup()
  const first = await shim.config.get()
  const second = await shim.config.get()
  expect(callOps(ctx, "agent.list")).toBe(1)
  expect(callOps(ctx, "tool.list")).toBe(1)
  expect(second.data).toEqual(first.data)
  const tools = first.data?.tools ?? {}
  expect(tools["task"]).toBe(false)
  expect(tools["bash"]).toBe(true)
  const snapshot = createHostStateSnapshot(ctx)
  const projection = await snapshot.get()
  expect(Object.keys(projection.agent)).toContain("build")
}

export const hRegSnapshotRows: ParityRow[] = defineGroup("H-REG", [
  {
    suffix: "BASE-SNAPSHOT-AGENTS",
    title: "the snapshot projects the fixture host agents and recorded values survive refresh",
    kind: "hermetic",
    is: ["IS-2"],
    wave: 3,
    status: "checked",
    check: checkAgents,
  },
  {
    suffix: "BASE-SNAPSHOT-PERMISSIONS",
    title: "the permission correspondence maps the fixture rules and reports unmapped actions once",
    kind: "hermetic",
    is: ["IS-5"],
    wave: 3,
    status: "checked",
    check: checkPermissions,
  },
  {
    suffix: "BASE-SNAPSHOT-MCP",
    title: "a V2 mcp server config becomes the V1 McpConfig shape and list entries stay present",
    kind: "hermetic",
    is: ["IS-6"],
    wave: 3,
    status: "checked",
    check: checkMcp,
  },
  {
    suffix: "BASE-SNAPSHOT-SHIM",
    title: "the shim config.get is served by the snapshot: one source, one read",
    kind: "hermetic",
    is: ["IS-5"],
    wave: 3,
    status: "checked",
    check: checkShim,
  },
])
