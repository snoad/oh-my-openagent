import { expect } from "./bun-test-shim"

import { createFakeV2Context } from "./fake-v2-context"
import { defineGroup, type ParityRow } from "./rows"
import { createHostStateSnapshot } from "../registration/host-state-snapshot"
import { registerToolTransform, type ToolRegistrationEngine } from "../registration/tools"
import { toolInputSchema, type V1ToolDefinitionMirror } from "../registration/tool-codec"
import type { PlanSourceEngine } from "../registration/plan-source-context"
import type { PlanStep } from "../registration/plan-steps"
import type { V1ConfigProjection } from "../registration/v1-config-projection"

// Wave-3 H-HOOK row (plan task 25): the snippet refresh drives the V1
// tool.definition handler the way SRC/plugin-interface.ts does - one call per
// visible tool with the JSON Schema parameters, skipping the host-only name
// "invalid" - so toolSnippets and the todoDescriptionOverride hook match V1.
// The row joins the H-HOOK group through the rows-h-hook-tool.ts spread.

async function checkToolDefinitionRefresh(): Promise<void> {
  const stubTool: V1ToolDefinitionMirror = {
    description: "stub grep",
    args: { pattern: { _zod: { def: { type: "string" }, toJSONSchema: () => ({ type: "string" }) } } },
    execute: async () => "ok",
  }
  const ctx = createFakeV2Context()
  const snapshot = createHostStateSnapshot(ctx)
  const calls: Array<{ toolID: string; parameters: unknown }> = []
  // The stub tool mirrors the V1 definition, not the SDK zod-args record; the
  // tolerant mirror crosses at this one boundary (the task-12/14 precedent).
  const engine: ToolRegistrationEngine & PlanSourceEngine = {
    tool: { grep: stubTool, invalid: stubTool } as unknown as ToolRegistrationEngine["tool"],
    "tool.definition": async (input, output) => {
      calls.push({ toolID: input.toolID, parameters: output.parameters })
    },
  }
  const registered: PlanStep[] = []
  const base: V1ConfigProjection = {
    agent: {},
    tools: {},
    permission: {},
    mcp: {},
    command: {},
    provider: {},
    unmapped: [],
  }
  const planSource = {
    registerStep: (step: PlanStep) => {
      registered.push(step)
    },
    addOwnToolMarkers: () => undefined,
    ownToolMarkers: new Map<string, string>(),
    reportOwnToolLoss: () => undefined,
    recompute: async () => {
      for (const step of registered) await step.run({ ctx, engine, snapshot, base, plan: undefined, apply: true })
    },
  }
  await registerToolTransform(
    { planSource, tool: ctx.tool as unknown as Parameters<typeof registerToolTransform>[0]["tool"] },
    engine,
    snapshot,
  )

  expect(
    calls.map((call) => call.toolID),
    "the host-only invalid name is skipped",
  ).toEqual(["grep"])
  expect(calls[0]?.parameters, "the parameters carry the JSON Schema input").toEqual(toolInputSchema(stubTool.args))
  const tools = await ctx.tool.list()
  expect(
    tools.some((tool) => tool.id === "grep"),
    "the tool landed on the editor",
  ).toBe(true)
}

export const hHookToolDefinitionRows: ParityRow[] = defineGroup("H-HOOK", [
  {
    suffix: "TOOL-DEFINITION",
    title:
      "the snippet refresh calls the V1 tool.definition handler once per visible tool with the JSON Schema parameters, skipping the host-only invalid name",
    kind: "hermetic",
    is: ["IS-4"],
    wave: 3,
    status: "checked",
    check: checkToolDefinitionRefresh,
  },
])
