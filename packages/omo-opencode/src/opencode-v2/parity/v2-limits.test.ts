import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "bun:test"

import { LANDED_WAVES } from "./lan"
import { V2_LIMITS, type V2Limit } from "./v2-limits"

function pluginDistRoot(): string {
  const packageJsonPath = Bun.resolveSync("@opencode/plugin/package.json", import.meta.dir)
  return join(packageJsonPath, "..", "dist")
}

// A confirmed limit must point at a real declaration inside the pinned
// @opencode/plugin dist: `<d.ts path>#<member or line range>`. Free strings are
// rejected because neither the file nor the member resolves.
function resolveApiEvidence(limit: V2Limit): void {
  // given
  const evidence = limit.apiEvidence ?? ""
  const hashIndex = evidence.indexOf("#")

  // when / then
  expect(hashIndex, `${limit.id} apiEvidence must be <d.ts path>#<member or line range>`).toBeGreaterThan(0)
  const relativePath = evidence.slice(0, hashIndex)
  const fragment = evidence.slice(hashIndex + 1)
  expect(
    relativePath.endsWith(".d.ts"),
    `${limit.id} apiEvidence path must be a .d.ts file under @opencode/plugin/dist`,
  ).toBe(true)
  expect(fragment.length, `${limit.id} apiEvidence has an empty member or line range`).toBeGreaterThan(0)
  const absolutePath = join(pluginDistRoot(), relativePath)
  expect(existsSync(absolutePath), `${limit.id} apiEvidence does not resolve under @opencode/plugin/dist`).toBe(true)
  const content = readFileSync(absolutePath, "utf8")
  const lineRange = fragment.match(/^L?(\d+)(?:-L?(\d+))?$/)
  if (lineRange) {
    const start = Number(lineRange[1])
    const end = lineRange[2] === undefined ? start : Number(lineRange[2])
    const lineCount = content.split("\n").length
    expect(
      start >= 1 && end >= start && end <= lineCount,
      `${limit.id} apiEvidence line range is outside ${relativePath}`,
    ).toBe(true)
    return
  }
  expect(content.includes(fragment), `${limit.id} apiEvidence member is not declared in ${relativePath}`).toBe(true)
}

describe("OpenCode 2 limits ledger", () => {
  it("resolves every confirmed limit against the pinned plugin dist with a passing graceful check", async () => {
    // given
    const confirmed = V2_LIMITS.filter((limit) => limit.status === "confirmed")

    // when / then
    for (const limit of confirmed) {
      expect(limit.apiEvidence, `${limit.id} is confirmed without apiEvidence`).toBeDefined()
      resolveApiEvidence(limit)
      expect(typeof limit.gracefulCheck, `${limit.id} is confirmed without a graceful check`).toBe("function")
      await limit.gracefulCheck?.()
    }
  })

  it("maps every limit to at least one IS", () => {
    // given / when / then
    for (const limit of V2_LIMITS) {
      expect(limit.is.length, `${limit.id} maps to no IS`).toBeGreaterThan(0)
    }
  })

  it("allows the limit path only for limits mapped to IS-4, IS-9 or IS-13", () => {
    // given
    const limitAllowedIs = new Set<string>(["IS-4", "IS-9", "IS-13"])

    // when / then
    for (const limit of V2_LIMITS) {
      const mappedToAllowed = limit.is.some((isId) => limitAllowedIs.has(isId))
      expect(mappedToAllowed, `${limit.id} uses the limit path outside IS-4, IS-9 and IS-13`).toBe(true)
    }
  })

  it("keeps candidate limits only while waves are still landing", () => {
    // given / when / then
    for (const limit of V2_LIMITS) {
      if (limit.status !== "candidate") continue
      expect(LANDED_WAVES < 6, `${limit.id} is still candidate after wave 6`).toBe(true)
    }
  })
})
