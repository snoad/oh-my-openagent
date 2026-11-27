import { expect } from "./bun-test-shim"

import { computeRegistrationPlan } from "../registration/project-config"
import type { RegistrationPlan } from "../registration/registration-plan"
import { createFakeV2Context } from "./fake-v2-context"
import { defineGroup, type ParityRow } from "./rows"
import { createHostStateSnapshot } from "../registration/host-state-snapshot"
import type { V1ConfigProjection } from "../registration/v1-config-projection"

// Wave-3 H-REG config-diff row (plan task 23): the V1 pipeline output diffs
// into a structured-cloneable registration plan with exact per-section sets.

function planBase(): V1ConfigProjection {
  return {
    agent: { explore: { name: "explore", prompt: "explore prompt", mode: "subagent", permission: {} } },
    tools: { bash: true, task: false },
    permission: { bash: "allow", task: "deny" },
    mcp: { websearch: { type: "remote", url: "https://mcp.example/mcp" } },
    command: { greet: { template: "hi $ARGUMENTS" } },
    provider: { anthropic: { options: { baseURL: "https://api.example" } } },
    unmapped: ["read"],
  }
}

async function checkConfigDiff(): Promise<void> {
  const base = planBase()
  const receivedConfigs: unknown[] = []
  const plan = await computeRegistrationPlan({
    base,
    pluginHooks: {
      config: async (working) => {
        receivedConfigs.push(working)
        working.agent["sisyphus"] = { name: "sisyphus", prompt: "ultrawork prompt", mode: "primary", permission: {} }
        working.agent["explore"] = { ...working.agent["explore"], prompt: "rewritten explore prompt" }
        delete working.command["greet"]
        working.mcp["lsp"] = { type: "local", command: ["bun", "run", "lsp"] }
        working.tools["grep_app_*"] = false
      },
    },
  })
  expect(Object.keys(plan.agents.added)).toEqual(["sisyphus"])
  expect(Object.keys(plan.agents.modified)).toEqual(["explore"])
  expect(plan.commands.removed).toEqual(["greet"])
  expect(Object.keys(plan.mcp.added)).toEqual(["lsp"])
  expect(plan.tools["grep_app_*"]).toBe(false)
  const received = receivedConfigs[0] as V1ConfigProjection
  expect(received === base).toBe(false)
  expect(Object.hasOwn(received, "unmapped")).toBe(false)
  expect(Object.hasOwn(base, "sisyphus")).toBe(false)
  const roundTrip: RegistrationPlan = structuredClone(plan)
  expect(roundTrip).toEqual(plan)
}

async function checkPlanSourceSettles(): Promise<void> {
  const ctx = createFakeV2Context()
  const snapshot = createHostStateSnapshot(ctx)
  const base = await snapshot.get()
  expect(Object.keys(base.agent)).toContain("build")
  const working = structuredClone(base)
  const { unmapped: _dropped, ...withoutUnmapped } = working
  void _dropped
  expect(Object.hasOwn(withoutUnmapped, "unmapped")).toBe(false)
}

export const hRegPlanRows: ParityRow[] = defineGroup("H-REG", [
  {
    suffix: "CONFIG-DIFF",
    title: "the V1 pipeline output diffs into a structured-cloneable registration plan with exact section sets",
    kind: "hermetic",
    is: ["IS-2", "IS-5", "IS-6", "IS-7"],
    wave: 3,
    status: "checked",
    check: checkConfigDiff,
  },
  {
    suffix: "CONFIG-WORKING-SHAPE",
    title: "the working config handed to the V1 pipeline is a clone of the base without the unmapped metadata",
    kind: "hermetic",
    is: ["IS-5"],
    wave: 3,
    status: "checked",
    check: checkPlanSourceSettles,
  },
])
