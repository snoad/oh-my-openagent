import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadSkillsFromDir } from "./skill-directory-loader"

// The probed skill roots are optional: a fresh install lacks every default
// one, so an absent directory must come back empty with NO diagnostic (the
// per-boot ENOENT reports used to dominate the plugin log volume), while a
// real directory error still reports.

describe("loadSkillsFromDir", () => {
  it("#given an absent skill root #when the directory loads #then the result is empty and no diagnostic reports", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "skills-loader-absent-"))
    const absent = join(root, "skills")
    const diagnostics: Array<{ readonly category: string; readonly path: string }> = []
    try {
      // when
      const skills = await loadSkillsFromDir({
        skillsDir: absent,
        scope: "user",
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      })

      // then
      expect(skills).toEqual([])
      expect(diagnostics).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("#given a skill root that is a symlink loop #when the directory loads #then a real error still reports", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "skills-loader-loop-"))
    const loop = join(root, "skills")
    symlinkSync(loop, loop)
    const diagnostics: Array<{ readonly category: string; readonly message: string }> = []
    try {
      // when
      const skills = await loadSkillsFromDir({
        skillsDir: loop,
        scope: "user",
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      })

      // then
      expect(skills).toEqual([])
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.category).toBe("skill-load-error")
      expect(diagnostics[0]?.message).toContain("ELOOP")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
