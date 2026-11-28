import { readFileSync } from "node:fs"

import { expect } from "./bun-test-shim"
import { defineGroup, type ParityRow } from "./rows"

// H-META-CI-WORKFLOW (wave 2, IS-14): the live-parity CI workflow stays glued
// to the repo's real files. Its check reads the workflow, ci.yml and
// lib/v2-versions.sh; it never reads PARITY_ROWS, so unlike the other H-META
// rows it lives in its own file and is spread into PARITY_ROWS next to them.
const REPO_ROOT = `${import.meta.dir}/../../../../..`

function readRepoText(relativePath: string): string {
  return readFileSync(`${REPO_ROOT}/${relativePath}`, "utf8")
}

function trimmedLine(lines: readonly string[], needle: string): string {
  return (lines.find((line) => line.includes(needle)) ?? "").trim()
}

export const hMetaCiRows: ParityRow[] = defineGroup("H-META", [
  {
    suffix: "CI-WORKFLOW",
    title: "the CI workflow drives the pinned live parity run",
    kind: "hermetic",
    is: ["IS-14"],
    wave: 2,
    status: "checked",
    check: () => {
      const workflowPath = ".github/workflows/opencode-v2-parity.yml"
      const ciPath = ".github/workflows/ci.yml"
      const workflow = readRepoText(workflowPath)
      const workflowLines = workflow.split("\n").map((line) => line.trim())
      const ciLines = readRepoText(ciPath).split("\n")
      const ciBunAction = trimmedLine(ciLines, "oven-sh/setup-bun@")
      const ciBunVersion = trimmedLine(ciLines, "bun-version:")
      const ciRunner = trimmedLine(ciLines, "runs-on: ubuntu-")
      const pinSource = ".agents/skills/opencode-qa/scripts/lib/v2-versions.sh"
      const pinText = readRepoText(pinSource)
      const pinnedVersion = (pinText.match(/OC2_VERSION="([^"]+)"/) ?? [])[1] ?? ""
      const v1PinnedVersion = (pinText.match(/V1_VERSION="([^"]+)"/) ?? [])[1] ?? ""
      expect(
        pinnedVersion !== "",
        `${pinSource}: no OC2_VERSION literal found (workflow under test: ${workflowPath})`,
      ).toBe(true)
      expect(
        v1PinnedVersion !== "",
        `${pinSource}: no V1_VERSION literal found (workflow under test: ${workflowPath})`,
      ).toBe(true)
      expect(
        workflow.includes("v2-bootstrap.sh"),
        `${workflowPath}: must invoke v2-bootstrap.sh (the single entry to the pinned host version)`,
      ).toBe(true)
      expect(
        workflow.includes("OC2_VERSION"),
        `${workflowPath}: must not mention OC2_VERSION; the host pin has exactly one source (${pinSource})`,
      ).toBe(false)
      expect(
        workflow.includes(pinnedVersion),
        `${workflowPath}: must not inline the pinned host version '${pinnedVersion}'; the pin has exactly one source (${pinSource})`,
      ).toBe(false)
      expect(
        workflow.includes(v1PinnedVersion),
        `${workflowPath}: must not inline the pinned OpenCode 1 host version '${v1PinnedVersion}'; the pin has exactly one source (${pinSource})`,
      ).toBe(false)
      expect(
        workflowLines.includes(ciBunAction),
        `${workflowPath}: the oven-sh/setup-bun line must be byte-equal to ci.yml's first occurrence ('${ciBunAction}')`,
      ).toBe(true)
      expect(
        workflowLines.includes(ciBunVersion),
        `${workflowPath}: the bun-version line must be byte-equal to ci.yml's first occurrence ('${ciBunVersion}')`,
      ).toBe(true)
      expect(
        workflowLines.includes(ciRunner),
        `${workflowPath}: the runner label must equal ci.yml's Linux label ('${ciRunner}')`,
      ).toBe(true)
      for (const clause of [
        "v2-parity-live.sh",
        "LANDED_WAVES",
        "--ci",
        "--skip-v1",
        "--no-build",
        "--recapture-v1-baseline",
      ]) {
        expect(workflow.includes(clause), `${workflowPath}: the run step must carry '${clause}'`).toBe(true)
      }
      expect(
        workflow.includes("lib/v2-versions.sh"),
        `${workflowPath}: must source ${pinSource} when installing the OpenCode 1 host (no second copy of the V1 pin)`,
      ).toBe(true)
      expect(
        workflow.includes("opencode-ai@"),
        `${workflowPath}: must install the pinned OpenCode 1 host through npm ('opencode-ai@<V1_VERSION>' from ${pinSource})`,
      ).toBe(true)
      expect(workflow.includes(".omo/evidence"), `${workflowPath}: the upload step must carry .omo/evidence`).toBe(true)
      expect(
        workflow.includes("retention-days: 14"),
        `${workflowPath}: the upload step must set retention-days: 14`,
      ).toBe(true)
    },
  },
])
