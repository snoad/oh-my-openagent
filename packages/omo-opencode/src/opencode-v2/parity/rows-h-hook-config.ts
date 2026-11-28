import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect } from "./bun-test-shim"

import { validatePluginConfig } from "../../config/validate"
import { createConfigHandler } from "../../plugin-handlers/config-handler"
import { createModelCacheState } from "../../plugin-state"
import { createHostStateSnapshot } from "../registration/host-state-snapshot"
import { computeRegistrationPlan } from "../registration/project-config"
import { createFakeV2Context } from "./fake-v2-context"
import { defineGroup, type ParityRow } from "./rows"

// Wave-3 H-HOOK row for the `config` handler (plan task 23): the REAL V1
// pipeline (SRC/plugin-handlers/config-handler.ts plus the agent prompt
// rewrite) runs over the task-22 snapshot projection of the fixture ctx
// through computeRegistrationPlan. The hermetic atlas model override mirrors
// the documented keyless-sandbox fix (task 3: model resolution otherwise
// skips atlas).

const CANONICAL_AGENTS = ["sisyphus", "hephaestus", "prometheus", "atlas"] as const

function canonicalAgentKeys(keys: readonly string[]): string[] {
  return keys.map((key) => (key.split(" - ")[0] ?? key).toLowerCase())
}

async function checkConfigHandler(): Promise<void> {
  const ctx = createFakeV2Context()
  const snapshot = createHostStateSnapshot(ctx)
  const base = await snapshot.get()
  const home = mkdtempSync(join(tmpdir(), "omo-t23-config-hook-"))
  try {
    const validation = validatePluginConfig(home, { HOME: home })
    const pluginConfig = {
      ...validation.config,
      agents: { ...validation.config.agents, atlas: { model: "anthropic/claude-sonnet-5" } },
    }
    const configHandler = createConfigHandler({
      ctx: { directory: home },
      pluginConfig,
      modelCacheState: createModelCacheState(),
    })
    const plan = await computeRegistrationPlan({ base, pluginHooks: { config: configHandler } })
    const agentKeys = canonicalAgentKeys(Object.keys(plan.agents.added))
    for (const canonical of CANONICAL_AGENTS) {
      expect(agentKeys, `canonical agent ${canonical} in plan.agents.added`).toContain(canonical)
    }
    expect(Object.keys(plan.commands.added).length, "commands added by the pipeline").toBeGreaterThan(0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

export const hHookConfigRows: ParityRow[] = defineGroup("H-HOOK", [
  {
    suffix: "CONFIG",
    title: "the real V1 config pipeline runs over the snapshot projection and plans the omo agents and commands",
    kind: "hermetic",
    is: ["IS-4"],
    wave: 3,
    status: "checked",
    check: checkConfigHandler,
  },
])
