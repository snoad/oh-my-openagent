import { describe, expect, it } from "bun:test"

import { createFakeV2Context, type FakeV2Context } from "../parity/fake-v2-context"
import { createHostStateSnapshot } from "./host-state-snapshot"
import type { V1ConfigProjection } from "./v1-config-projection"

// Contract tests for the host state snapshot (task 22 of the
// opencode-v2-compat plan): pristine recorded domains, ctx fallback reads for
// never-recorded domains, caching and refresh.

function callOps(ctx: FakeV2Context, op: string): number {
  return ctx.__calls.filter((call) => call.op === op).length
}

function fixtureAgentNames(projection: V1ConfigProjection): string[] {
  return Object.keys(projection.agent)
}

describe("host state snapshot", () => {
  it("#given the fixture-backed fake ctx #when get is called once #then the projection carries the host agents and tools", async () => {
    // given
    const ctx = createFakeV2Context()
    const snapshot = createHostStateSnapshot(ctx)

    // when
    const projection = await snapshot.get()

    // then
    expect(fixtureAgentNames(projection)).toContain("build")
    expect(fixtureAgentNames(projection)).toContain("explore")
    expect(projection.agent["explore"]?.mode).toBe("subagent")
    expect(Object.keys(projection.tools).length).toBeGreaterThan(0)
    expect(projection.tools["bash"]).toBe(true)
    expect(projection.tools["task"]).toBe(false)
    expect(projection.permission["bash"]).toBe("allow")
    expect(projection.command).toEqual({})
    expect(Object.keys(projection.mcp)).toEqual([])
  })

  it("#given no recorded domain #when get is called twice #then the ctx is read once and the cache serves the second call", async () => {
    // given
    const ctx = createFakeV2Context()
    const snapshot = createHostStateSnapshot(ctx)

    // when
    const first = await snapshot.get()
    const second = await snapshot.get()

    // then
    expect(callOps(ctx, "agent.list")).toBe(1)
    expect(callOps(ctx, "tool.list")).toBe(1)
    expect(second).toEqual(first)
  })

  it("#given a recorded agent value #when the live editor gains an agent and refresh runs #then the recorded value survives and ctx is never re-read", async () => {
    // given
    const ctx = createFakeV2Context()
    const snapshot = createHostStateSnapshot(ctx)
    await ctx.agent.transform((editor) => {
      snapshot.record({ domain: "agent", value: { agents: editor.list(), defaultAgent: editor.defaultAgent() } })
      editor.add({ id: "late-agent", name: "LateAgent", mode: "subagent", hidden: false })
    })

    // when
    const before = await snapshot.get()
    await snapshot.refresh()
    const after = await snapshot.get()

    // then
    expect(callOps(ctx, "agent.list")).toBe(0)
    expect(before.agent["LateAgent"]).toBeUndefined()
    expect(after.agent["LateAgent"]).toBeUndefined()
    expect(fixtureAgentNames(after)).toEqual(fixtureAgentNames(before))
    expect(callOps(ctx, "agent.list")).toBe(0)
  })

  it("#given a recorded tool domain #when refresh runs #then only the unrecorded domains hit the ctx", async () => {
    // given
    const ctx = createFakeV2Context()
    const snapshot = createHostStateSnapshot(ctx)
    snapshot.record({ domain: "tool", value: [{ id: "tool-a", description: "recorded tool" }] })

    // when
    await snapshot.get()
    expect(callOps(ctx, "tool.list")).toBe(0)
    await snapshot.refresh()

    // then
    expect(callOps(ctx, "tool.list")).toBe(0)
    expect(callOps(ctx, "agent.list")).toBeGreaterThanOrEqual(1)
    expect(callOps(ctx, "mcp.list")).toBeGreaterThanOrEqual(1)
    expect(callOps(ctx, "command.list")).toBeGreaterThanOrEqual(1)
    expect(callOps(ctx, "provider.list")).toBeGreaterThanOrEqual(1)
    expect(callOps(ctx, "model.list")).toBeGreaterThanOrEqual(1)
  })

  it("#given a record arriving after a cached get #when get runs again #then the projection reflects the record without a ctx read", async () => {
    // given
    const ctx = createFakeV2Context()
    const snapshot = createHostStateSnapshot(ctx)
    const stale = await snapshot.get()
    expect(callOps(ctx, "command.list")).toBe(1)
    snapshot.record({
      domain: "command",
      value: [{ name: "recorded-command", description: "recorded before edits" }],
    })

    // when
    const next = await snapshot.get()

    // then
    expect(callOps(ctx, "command.list")).toBe(1)
    expect(next.command["recorded-command"]?.template).toBe("")
    expect(next.command["recorded-command"]?.description).toBe("recorded before edits")
    expect(stale.command["recorded-command"]).toBeUndefined()
  })

  it("#given fixture agents with unmapped permission actions #when the projection builds #then every unmapped action is listed and logged once", async () => {
    // given
    const ctx = createFakeV2Context()
    const logs: Array<{ message: string; action: unknown }> = []
    const snapshot = createHostStateSnapshot(ctx, {
      log: (message, detail) => logs.push({ message, action: (detail as { action?: unknown }).action }),
    })

    // when
    const projection = await snapshot.get()
    await snapshot.refresh()

    // then
    expect(projection.unmapped).toContain("read")
    expect(projection.unmapped).toContain("browser")
    const readLogs = logs.filter((entry) => entry.action === "read")
    expect(readLogs.length).toBe(1)
    expect(logs.length).toBe(projection.unmapped.length)
  })

  it("#given recorded permission rules #when the projection builds #then the permission record wins over the agent-derived rules", async () => {
    // given
    const ctx = createFakeV2Context()
    const snapshot = createHostStateSnapshot(ctx)
    snapshot.record({
      domain: "permission",
      value: [{ action: "shell", resource: "*", effect: "deny" }],
    })

    // when
    const projection = await snapshot.get()

    // then
    expect(projection.permission["bash"]).toBe("deny")
    expect(projection.tools["bash"]).toBe(false)
  })
})
