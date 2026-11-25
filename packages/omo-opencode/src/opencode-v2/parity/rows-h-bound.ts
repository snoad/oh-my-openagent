import { expect, setDefaultTimeout } from "bun:test"

import { importRuleResults, type ImportRuleId } from "../v2-boundary-imports"
import { runEntryHashRule, runFileSizeRule, runNamingRule, type BoundaryRuleResult } from "../v2-boundary-rules"
import { defineGroup, type ParityRow } from "./rows"

// Wave-0 boundary rows. The six rows map one-to-one onto the boundary rules
// (a) to (f) of the opencode-v2-compat plan; each check runs the real rule
// from v2-boundary-imports.ts / v2-boundary-rules.ts, so the matrix exercises
// the same assertions as V2/v2-boundary.test.ts. The budget mirrors
// SRC/shared/prompt-async-route-audit.test.ts for the TypeScript native parse.
setDefaultTimeout(process.platform === "win32" ? 60_000 : 30_000)

async function expectNoViolations(result: BoundaryRuleResult): Promise<void> {
  expect(result.violations, `${result.rule} violations`).toEqual([])
}

async function expectImportRuleClean(ruleId: ImportRuleId): Promise<void> {
  await expectNoViolations((await importRuleResults())[ruleId])
}

export const hBoundRows: ParityRow[] = defineGroup("H-BOUND", [
  {
    suffix: "IMPORT-DIRECTION",
    title: "no file under SRC outside V2 imports from opencode-v2/ except the three entry seams",
    kind: "hermetic",
    is: ["IS-12", "IS-16"],
    wave: 0,
    status: "checked",
    check: async () => {
      await expectImportRuleClean("IMPORT-DIRECTION")
    },
  },
  {
    suffix: "PLUGIN-RUNTIME-IMPORTS",
    title: "inside V2 the only @opencode runtime imports are the two define leaf modules",
    kind: "hermetic",
    is: ["IS-12", "IS-16"],
    wave: 0,
    status: "checked",
    check: async () => {
      await expectImportRuleClean("PLUGIN-RUNTIME-IMPORTS")
    },
  },
  {
    suffix: "EFFECT-BAN",
    title: "no file under V2 imports effect",
    kind: "hermetic",
    is: ["IS-12", "IS-16"],
    wave: 0,
    status: "checked",
    check: async () => {
      await expectImportRuleClean("EFFECT-BAN")
    },
  },
  {
    suffix: "NAMING",
    title: "every file under V2 is kebab-case with no catch-all file names",
    kind: "hermetic",
    is: ["IS-12", "IS-16"],
    wave: 0,
    status: "checked",
    check: async () => {
      await expectNoViolations(await runNamingRule())
    },
  },
  {
    suffix: "FILE-SIZE",
    title: "non-test files under V2 stay within 200 lines and test files within 400",
    kind: "hermetic",
    is: ["IS-12", "IS-16"],
    wave: 0,
    status: "checked",
    check: async () => {
      await expectNoViolations(await runFileSizeRule())
    },
  },
  {
    suffix: "ENTRY-HASHES",
    title: "SRC/index.ts and SRC/tui.ts stay byte-identical to the recorded hashes",
    kind: "hermetic",
    is: ["IS-12", "IS-16"],
    wave: 0,
    status: "checked",
    check: async () => {
      await expectNoViolations(await runEntryHashRule())
    },
  },
])
