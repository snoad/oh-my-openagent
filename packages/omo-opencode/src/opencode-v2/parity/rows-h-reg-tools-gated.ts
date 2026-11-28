import { releaseAllPromptAsyncReservationsForTesting } from "@oh-my-opencode/utils/prompt-async-gate"

import { expect } from "./bun-test-shim"
import { resetV2ProcessStateForTesting } from "../runtime/v2-runtime-deps"
import type { OhMyOpenCodeConfig } from "../../config"
import { GoalConfigSchema } from "../../config/schema/goal"
import { MonitorConfigSchema } from "../../config/schema/monitor"
import { TeamModeConfigSchema } from "../../config/schema/team-mode"
import { bootToolFamilyEngine, checkToolFamily, stopToolFamilyBoot } from "./rows-h-reg-tools"
import { defineGroup, type ParityRow, type ParityRowGroupItem } from "./rows"

// Wave-3 H-REG tool family rows (plan task 25, part 2 of 2): the config-gated
// families. Each row boots the real engine over the hermetic ctx with the
// family's config gate enabled and asserts the gated tools are visible with a
// JSON Schema input.

// The gate sections are parsed from the Zod schemas so the required fields
// carry the schema defaults instead of hand-copied fallbacks.
const GOAL_GATE: NonNullable<OhMyOpenCodeConfig["goal"]> = GoalConfigSchema.parse({ enabled: true })
const MONITOR_GATE: NonNullable<OhMyOpenCodeConfig["monitor"]> = MonitorConfigSchema.parse({ enabled: true })
const TEAM_MODE_GATE: NonNullable<OhMyOpenCodeConfig["team_mode"]> = TeamModeConfigSchema.parse({ enabled: true })

const GOAL_TOOLS = ["create_goal", "update_goal", "get_goal"] as const
const TASK_SYSTEM_TOOLS = ["task_create", "task_get", "task_list", "task_update"] as const
const MONITOR_TOOLS = ["monitor_start", "monitor_stop", "monitor_list", "monitor_output"] as const
const TEAM_TOOLS = [
  "team_create",
  "team_delete",
  "team_shutdown_request",
  "team_approve_shutdown",
  "team_reject_shutdown",
  "team_send_message",
  "team_task_create",
  "team_task_list",
  "team_task_update",
  "team_task_get",
  "team_status",
  "team_list",
] as const

async function checkEditToolRegisters(): Promise<void> {
  // given: hashline_edit is a top-level config gate (the driver sandbox writes
  // it under the [opencode] harness block the same way)
  resetV2ProcessStateForTesting()
  const boot = await bootToolFamilyEngine((config) => ({ ...config, hashline_edit: true }))
  try {
    const tools = await boot.ctx.tool.list()
    const edit = tools.find((tool) => tool.id === "edit")
    expect(edit, "the hashline edit tool missing from the visible tool set").toBeDefined()
    expect(
      (edit?.parameters as { required?: unknown } | undefined)?.required,
      "the hashline edit required args differ from the V1 plugin tool",
    ).toEqual(["filePath", "edits"])
  } finally {
    await stopToolFamilyBoot(boot)
  }
}

async function checkGatedFamilyAbsentWithoutConfig(names: readonly string[]): Promise<void> {
  // the gate-off boot must not show the family (the engine filter owns gating)
  resetV2ProcessStateForTesting()
  const boot = await bootToolFamilyEngine()
  try {
    const ids = new Set((await boot.ctx.tool.list()).map((tool) => tool.id))
    for (const name of names) expect(ids.has(name), `${name} visible without its config gate`).toBe(false)
  } finally {
    await stopToolFamilyBoot(boot)
  }
}

function gatedRow(
  suffix: string,
  title: string,
  names: readonly string[],
  gate: (config: OhMyOpenCodeConfig) => OhMyOpenCodeConfig,
): ParityRowGroupItem {
  return {
    suffix,
    title,
    kind: "hermetic",
    is: ["IS-3", "IS-5"],
    wave: 3,
    status: "checked",
    check: async () => {
      await checkToolFamily(names, gate)
      await checkGatedFamilyAbsentWithoutConfig(names)
    },
  }
}

export const hRegToolGatedRows: ParityRow[] = defineGroup("H-REG", [
  gatedRow(
    "TOOL-GOAL",
    "the goal registry tools (create_goal, update_goal, get_goal) register on OpenCode 2 under goal.enabled and stay off without it",
    GOAL_TOOLS,
    (config) => ({ ...config, goal: GOAL_GATE }),
  ),
  gatedRow(
    "TOOL-TASK-SYSTEM",
    "the task_* registry tools register on OpenCode 2 under experimental.task_system and stay off without it",
    TASK_SYSTEM_TOOLS,
    (config) => ({ ...config, experimental: { ...config.experimental, task_system: true } }),
  ),
  {
    suffix: "TOOL-EDIT",
    title: "the hashline edit tool registers on OpenCode 2 under hashline_edit with the V1 required args",
    kind: "hermetic",
    is: ["IS-3", "IS-5"],
    wave: 3,
    status: "checked",
    check: checkEditToolRegisters,
  },
  gatedRow(
    "TOOL-MONITOR",
    "the monitor_* registry tools register on OpenCode 2 under monitor.enabled and stay off without it",
    MONITOR_TOOLS,
    (config) => ({ ...config, monitor: MONITOR_GATE }),
  ),
  gatedRow(
    "TOOL-TEAM",
    "the twelve team_* registry tools register on OpenCode 2 under team_mode.enabled and stay off without it",
    TEAM_TOOLS,
    (config) => ({ ...config, team_mode: TEAM_MODE_GATE }),
  ),
])
