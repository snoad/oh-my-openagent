import { describe, expect, it } from "bun:test"

import { createFakeV2Context, type FakeV2Context } from "../parity/fake-v2-context"
import { createV2ClientShim } from "./v2-client-shim"

// Contract tests for the misc domains of the OpenCode 2 backed V1 client shim
// (tui/app/provider/config) and the unsupported-access guard. The session
// domain contracts live in v2-client-shim.test.ts.

function setup() {
  const ctx = createFakeV2Context()
  const logs: Array<[string, unknown]> = []
  const shim = createV2ClientShim(ctx, {
    promptWaitPollMs: 1,
    log: (message, detail) => {
      logs.push([message, detail])
    },
  })
  return { ctx, shim, logs }
}

function callOps(ctx: FakeV2Context, op: string): number {
  return ctx.__calls.filter((call) => call.op === op).length
}

describe("v2 client shim misc methods", () => {
  it("#given a toast input #when tui.showToast is called #then the log-only marker is emitted", async () => {
    // given
    const { shim, logs } = setup()

    // when
    const result = await shim.tui.showToast({ body: { message: "migration done", variant: "success" } })

    // then
    expect(result.data).toBe(true)
    expect(result.error).toBeUndefined()
    expect(logs[0]?.[0]).toBe("[opencode-v2] toast")
    expect(logs[0]?.[1]).toEqual({ message: "migration done", variant: "success" })
  })

  it("#given fake agents #when app.agents is called #then the V1 agent list is returned from ctx.agent.list", async () => {
    // given
    const { ctx, shim } = setup()

    // when
    const result = await shim.app.agents()

    // then
    expect(callOps(ctx, "agent.list")).toBe(1)
    expect(result.data.length).toBeGreaterThan(0)
    const agent = result.data[0]
    expect(typeof agent?.name).toBe("string")
    expect(agent?.mode === "primary" || agent?.mode === "subagent" || agent?.mode === "all").toBe(true)
    expect(typeof agent?.permission.edit).toBe("string")
  })

  it("#given the fake provider store #when provider.list is called #then the V1 provider envelope is returned", async () => {
    // given
    const { ctx, shim } = setup()

    // when
    const result = await shim.provider.list()

    // then
    expect(callOps(ctx, "provider.list")).toBe(1)
    expect(result.data.all).toEqual([])
    expect(result.data.default).toEqual({})
    expect(result.data.connected).toEqual([])
  })

  it("#given the fake agent and tool lists #when config.get is called twice #then the V1 projection is cached and returned once", async () => {
    // given
    const { ctx, shim } = setup()

    // when
    const first = await shim.config.get()
    const second = await shim.config.get()

    // then
    expect(callOps(ctx, "agent.list")).toBe(1)
    expect(callOps(ctx, "tool.list")).toBe(1)
    expect(second.data).toEqual(first.data)
    expect(first.data.agent).toBeDefined()
    expect(first.data.tools).toBeDefined()
    expect(first.data.permission["bash"]).toBe("allow")
    expect(Object.entries(first.data.permission ?? {})).toContainEqual(["task", "deny"])
    expect(first.data.tools["bash"]).toBe(true)
    expect(first.data.tools["task"]).toBe(false)
    expect(first.data.mcp).toEqual({})
    expect(first.data.command).toEqual({})
    const tools = first.data.tools ?? {}
    expect(Object.keys(tools).length).toBeGreaterThan(0)
  })

  it("#given an unsupported method on a supported domain #when it is accessed #then a descriptive error naming it is thrown", () => {
    // given
    const { shim } = setup()

    // when / then
    expect(() => shim.session.share).toThrow(/session\.share/)
  })

  it("#given an unsupported domain #when its method is called #then a descriptive error naming it is thrown and probing stays safe", () => {
    // given
    const { shim } = setup()

    // when / then
    expect("model" in shim).toBe(false)
    expect(shim.model?.list).toBeDefined()
    expect(() => shim.model.list()).toThrow(/model\.list/)
  })
})
