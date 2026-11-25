import { describe, expect, setDefaultTimeout, test } from "bun:test"

import { importRuleResults, type ImportRuleId } from "./v2-boundary-imports"
import { runEntryHashRule, runFileSizeRule, runNamingRule, type BoundaryRuleResult } from "./v2-boundary-rules"

// The import rules parse a slice of SRC through the TypeScript native API, which needs
// more than the 5s default on a loaded runner. setDefaultTimeout is per-file in Bun.
setDefaultTimeout(process.platform === "win32" ? 60_000 : 30_000)

async function expectNoViolations(result: BoundaryRuleResult): Promise<void> {
  expect(result.violations, `${result.rule} violations`).toEqual([])
}

async function expectImportRuleClean(ruleId: ImportRuleId): Promise<void> {
  await expectNoViolations((await importRuleResults())[ruleId])
}

describe("OpenCode 2 adapter boundary guard", () => {
  test("#given SRC outside opencode-v2 #when import direction is audited #then only the three entry seams reach opencode-v2", async () => {
    await expectImportRuleClean("IMPORT-DIRECTION")
  })

  test("#given the opencode-v2 tree #when @opencode runtime imports are audited #then only the pinned define leaves and allowed type imports remain", async () => {
    await expectImportRuleClean("PLUGIN-RUNTIME-IMPORTS")
  })

  test("#given the opencode-v2 tree #when effect imports are audited #then none exist", async () => {
    await expectImportRuleClean("EFFECT-BAN")
  })

  test("#given the opencode-v2 tree #when file names are audited #then every name is kebab-case with no catch-all file", async () => {
    await expectNoViolations(await runNamingRule())
  })

  test("#given the opencode-v2 tree #when file sizes are audited #then production files stay within 200 lines and tests within 400", async () => {
    await expectNoViolations(await runFileSizeRule())
  })

  test("#given the entry seams #when sha256 hashes are compared to the ledger #then both files are byte-identical to the recorded hashes", async () => {
    await expectNoViolations(await runEntryHashRule())
  })
})
