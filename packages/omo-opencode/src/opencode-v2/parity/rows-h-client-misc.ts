import { expect } from "./bun-test-shim"

import { createV2ClientShim } from "../client/v2-client-shim"
import { createFakeV2Context } from "./fake-v2-context"
import { callOps, row, rowSetup } from "./rows-h-client"
import { defineGroup, type ParityRow } from "./rows"

// Wave-1 H-CLIENT misc-domain rows (plan task 12): the tui/app/provider/config
// shim methods. Shares the H-CLIENT id space with rows-h-client.ts (distinct
// suffixes, one group prefix).

async function checkToast(): Promise<void> {
  const ctx = createFakeV2Context()
  const logs: Array<[string, unknown]> = []
  const shim = createV2ClientShim(ctx, { promptWaitPollMs: 1, log: (message, detail) => logs.push([message, detail]) })
  const result = await shim.tui.showToast({ body: { message: "row toast", variant: "success" } })
  expect(result.data).toBe(true)
  expect(logs[0]?.[0]).toBe("[opencode-v2] toast")
  expect(logs[0]?.[1]).toEqual({ message: "row toast", variant: "success" })
}

async function checkAgents(): Promise<void> {
  const { ctx, shim } = rowSetup()
  const result = await shim.app.agents()
  expect(callOps(ctx, "agent.list")).toBe(1)
  expect(result.data?.length ?? 0).toBeGreaterThan(0)
  expect(result.data?.every((agent) => typeof agent.name === "string" && typeof agent.permission.edit === "string") ?? false).toBe(true)
}

async function checkProviderList(): Promise<void> {
  const { ctx, shim } = rowSetup()
  const result = await shim.provider.list()
  expect(callOps(ctx, "provider.list")).toBe(1)
  expect(result.data).toEqual({ all: [], default: {}, connected: [] })
}

async function checkConfigGet(): Promise<void> {
  const { ctx, shim } = rowSetup()
  const first = await shim.config.get()
  const second = await shim.config.get()
  expect(callOps(ctx, "agent.list")).toBe(1)
  expect(callOps(ctx, "tool.list")).toBe(1)
  expect(second.data).toEqual(first.data)
  expect(Object.keys(first.data?.agent ?? {}).length).toBeGreaterThan(0)
  expect(Object.values(first.data?.tools ?? {}).every((enabled) => enabled === true)).toBe(true)
  expect(first.data?.permission).toEqual({})
}

export const hClientMiscRows: ParityRow[] = defineGroup("H-CLIENT", [
  row("TOAST", "tui.showToast emits the log-only marker and answers the V1 boolean", checkToast),
  row("AGENTS", "app.agents maps ctx.agent.list onto the V1 agent list", checkAgents),
  row("PROVIDER-LIST", "provider.list maps ctx.provider.list onto the V1 provider envelope", checkProviderList),
  row("CONFIG-GET", "config.get caches the V1-shaped projection built from ctx.agent.list and ctx.tool.list", checkConfigGet),
])
