import { hHookConfigRows } from "./rows-h-hook-config"
import { hRegPlanRows } from "./rows-h-reg-plan"
import { hRegProviderModelRows } from "./rows-h-reg-provider-model"
import { hRegSnapshotRows } from "./rows-h-reg-snapshot"
import type { ParityRow } from "./rows"

// Group index for the wave-3 registration rows: rows.ts carries exactly ONE
// import and ONE spread for the whole group budget, so this file spreads the
// task-22 base-snapshot rows, the task-23 plan rows, the config H-HOOK row
// and the task-28 provider and model rows into a single array.
export const hRegWaveRows: ParityRow[] = [...hRegSnapshotRows, ...hRegPlanRows, ...hHookConfigRows, ...hRegProviderModelRows]
