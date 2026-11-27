import { hHookConfigRows } from "./rows-h-hook-config"
import { hRegAgentRows } from "./rows-h-reg-agents"
import { hRegCommandRows } from "./rows-h-reg-command"
import { hRegMcpRows } from "./rows-h-reg-mcp"
import { hRegPermissionRows } from "./rows-h-reg-permission"
import { hRegPlanRows } from "./rows-h-reg-plan"
import { hRegProviderModelRows } from "./rows-h-reg-provider-model"
import { hRegSkillRows } from "./rows-h-reg-skill"
import { hRegSnapshotRows } from "./rows-h-reg-snapshot"
import { hRegToolGatedRows } from "./rows-h-reg-tools-gated"
import { hRegToolRows } from "./rows-h-reg-tools"
import { hRegTodoRows } from "./rows-h-reg-todo"
import type { ParityRow } from "./rows"

// Group index for the wave-3 registration rows: rows.ts carries exactly ONE
// import and ONE spread for the whole group budget, so this file spreads the
// task-22 base-snapshot rows, the task-23 plan rows, the task-24 agent rows,
// the config H-HOOK row, the task-25 tool family rows, the task-28 provider
// and model rows, the task-26 mcp rows and the task-27 command, skill and
// permission rows into a single array.
export const hRegWaveRows: ParityRow[] = [
  ...hRegSnapshotRows,
  ...hRegPlanRows,
  ...hRegAgentRows,
  ...hHookConfigRows,
  ...hRegToolRows,
  ...hRegToolGatedRows,
  ...hRegTodoRows,
  ...hRegProviderModelRows,
  ...hRegMcpRows,
  ...hRegCommandRows,
  ...hRegSkillRows,
  ...hRegPermissionRows,
]
