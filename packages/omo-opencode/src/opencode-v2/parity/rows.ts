import { expect } from "./bun-test-shim"

import { LANDED_WAVES } from "./lan"
import { hBoundRows } from "./rows-h-bound"
import { hCliRows } from "./rows-h-cli"
import { hCodecRows } from "./rows-h-codec"
import { hFakeRows } from "./rows-h-fake"
import { hClientRows, hGateRows } from "./rows-h-client"
import { hClientLifecycleRows } from "./rows-h-client-lifecycle"
import { hClientMiscRows } from "./rows-h-client-misc"
import { hDiRows } from "./rows-h-di"
import { hLoadRows } from "./rows-h-load"
import { hReloadRows } from "./rows-h-reload"
import { liveRows } from "./rows-live"
import { V2_LIMITS } from "./v2-limits"

export type IsRow =
  | "IS-1"
  | "IS-2"
  | "IS-3"
  | "IS-4"
  | "IS-5"
  | "IS-6"
  | "IS-7"
  | "IS-8"
  | "IS-9"
  | "IS-10"
  | "IS-11"
  | "IS-12"
  | "IS-13"
  | "IS-14"
  | "IS-15"
  | "IS-16"
  | "IS-17"

export type ParityRow = {
  id: string
  title: string
  kind: "hermetic" | "live"
  is: IsRow[]
  wave: number
  status: "pending" | "checked"
  check?: () => void | Promise<void>
  live?: string
}

export type ParityRowGroupItem = Omit<ParityRow, "id" | "status"> & {
  suffix: string
  status?: ParityRow["status"]
}

export const ALL_IS_IDS: readonly IsRow[] = [
  "IS-1",
  "IS-2",
  "IS-3",
  "IS-4",
  "IS-5",
  "IS-6",
  "IS-7",
  "IS-8",
  "IS-9",
  "IS-10",
  "IS-11",
  "IS-12",
  "IS-13",
  "IS-14",
  "IS-15",
  "IS-16",
  "IS-17",
]

// Builds one enumerated row group: each item becomes a row whose id is
// `<prefix>-<suffix>`. Rows default to pending; flipping a row means attaching
// its check and setting status to checked. Later waves append their own
// enumerated groups through this helper.
export function defineGroup(prefix: string, items: readonly ParityRowGroupItem[]): ParityRow[] {
  return items.map((item) => {
    const { suffix, status, ...rest } = item
    return { id: `${prefix}-${suffix}`, status: status ?? "pending", ...rest }
  })
}

// H-META rows assert the matrix invariants over PARITY_ROWS itself, so they
// live in this module next to the assembled ledger: their checks read
// PARITY_ROWS lazily at test time, long after this module finished evaluating.
const hMetaRows: ParityRow[] = [
  {
    id: "H-META-IS-COVERAGE",
    title: "every IS-1..IS-17 is covered by at least one parity row",
    kind: "hermetic",
    is: ["IS-13"],
    wave: 0,
    status: "checked",
    check: () => {
      const covered = new Set<string>(PARITY_ROWS.flatMap((row) => row.is))
      for (const isId of ALL_IS_IDS) {
        expect(covered.has(isId), `${isId} has no parity row`).toBe(true)
      }
    },
  },
  {
    id: "H-META-ROW-IS-MAPPING",
    title: "every parity row maps to at least one known IS",
    kind: "hermetic",
    is: ["IS-13"],
    wave: 0,
    status: "checked",
    check: () => {
      const known = new Set<string>(ALL_IS_IDS)
      for (const row of PARITY_ROWS) {
        expect(row.is?.length ?? 0, `${row.id} maps to no IS`).toBeGreaterThan(0)
        for (const isId of row.is) {
          expect(known.has(isId), `${row.id} maps to unknown ${isId}`).toBe(true)
        }
      }
    },
  },
  {
    id: "H-META-LANDED-CHECKS",
    title: "every hermetic row of a landed wave is checked with a passing check",
    kind: "hermetic",
    is: ["IS-13"],
    wave: 0,
    status: "checked",
    check: async () => {
      for (const row of PARITY_ROWS) {
        if (row.kind !== "hermetic" || row.wave > LANDED_WAVES) continue
        // Running its own check here would recurse forever; the matrix test
        // covers this row by invoking it directly.
        if (row.id === "H-META-LANDED-CHECKS") continue
        expect(row.status, `${row.id} wave ${row.wave} is landed but pending`).toBe("checked")
        expect(typeof row.check, `${row.id} has no check`).toBe("function")
        await row.check?.()
      }
    },
  },
  {
    id: "H-META-CANDIDATE-BUDGET",
    title: "no candidate limit remains once every wave has landed",
    kind: "hermetic",
    is: ["IS-13"],
    wave: 0,
    status: "checked",
    check: () => {
      if (LANDED_WAVES < 6) return
      const candidates = V2_LIMITS.filter((limit) => limit.status === "candidate")
      expect(candidates.map((limit) => limit.id)).toEqual([])
    },
  },
]

export const PARITY_ROWS: ParityRow[] = [
  ...hLoadRows,
  ...hBoundRows,
  ...hFakeRows,
  ...hCliRows,
  ...hCodecRows,
  ...hClientRows,
  ...hClientLifecycleRows,
  ...hClientMiscRows,
  ...hGateRows,
  ...hDiRows,
  ...hReloadRows,
  ...liveRows,
  ...hMetaRows,
]
