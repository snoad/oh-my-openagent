import { describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFakeV2Context, type FakeV2Context } from "../parity/fake-v2-context"
import { expectSameRealPath } from "../skill-path-assert.test-support"
import { contributeDiscoveredSkills, isValidSkillInfo, type SkillContributionOptions } from "./skills"

// Unit tests for the skill contribution (plan task 27): a discovered skill
// contributes with its real path and content, an id the host already lists is
// not duplicated, built-ins without an on-disk path are skipped through the
// report, and the disabled-skills filter drops a disabled skill.

const SKILL_BODY = "---\nname: oqa-probe-skill\ndescription: probe skill for task 27\n---\n\nprobe body\n"

async function listedSkillIds(ctx: FakeV2Context): Promise<string[]> {
  return (await ctx.skill.list()).data.map((skill) => skill.id)
}

async function contribute(ctx: FakeV2Context, options: SkillContributionOptions): Promise<void> {
  await contributeDiscoveredSkills(ctx, options)
}

describe("skill contribution", () => {
  it("#given a seeded claude skill directory #when the skills contribute #then the probe skill lands with its path and content", async () => {
    // given
    const seededDir = mkdtempSync(join(tmpdir(), "oqa-t27-skills-unit-"))
    const skillDir = join(seededDir, ".claude", "skills", "oqa-probe-skill")
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, "SKILL.md"), SKILL_BODY)
    const ctx = createFakeV2Context()
    try {
      // when
      await contribute(ctx, { skillDirectory: seededDir, onSkippedSkill: () => {} })

      // then
      const listed = await ctx.skill.list()
      const probe = listed.data.find((skill) => skill.id === "oqa-probe-skill")
      expect(probe, "the probe skill is contributed").toBeDefined()
      expect(probe?.content).toContain("probe body")
      expectSameRealPath(probe?.path, skillDir)
    } finally {
      rmSync(seededDir, { recursive: true, force: true })
    }
  })

  it("#given a skill root reached through a symlink #when the skills contribute #then the contributed path equals the seeded path by its real path", async () => {
    // given
    const realDir = mkdtempSync(join(tmpdir(), "oqa-t27-skills-linked-"))
    const seededDir = join(realDir, "link")
    symlinkSync(realDir, seededDir, "dir")
    const skillDir = join(seededDir, ".claude", "skills", "oqa-probe-skill")
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, "SKILL.md"), SKILL_BODY)
    const ctx = createFakeV2Context()
    try {
      // when
      await contribute(ctx, { skillDirectory: seededDir, onSkippedSkill: () => {} })

      // then
      const listed = await ctx.skill.list()
      const probe = listed.data.find((skill) => skill.id === "oqa-probe-skill")
      expect(probe, "the probe skill is contributed").toBeDefined()
      expect(probe?.content).toContain("probe body")
      expectSameRealPath(probe?.path, skillDir)
    } finally {
      rmSync(realDir, { recursive: true, force: true })
    }
  })

  it("#given the host already lists the id #when the skills contribute #then the host entry survives exactly once", async () => {
    // given
    const seededDir = mkdtempSync(join(tmpdir(), "oqa-t27-skills-host-"))
    const skillDir = join(seededDir, ".claude", "skills", "oqa-probe-skill")
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, "SKILL.md"), SKILL_BODY)
    const ctx = createFakeV2Context()
    await ctx.skill.transform((editor) => {
      editor.add({ id: "oqa-probe-skill", name: "oqa-probe-skill", path: "/host/own/skill", content: "host bytes" })
    })
    try {
      // when
      await contribute(ctx, { skillDirectory: seededDir, onSkippedSkill: () => {} })

      // then
      const listed = await ctx.skill.list()
      const probes = listed.data.filter((skill) => skill.id === "oqa-probe-skill")
      expect(probes).toHaveLength(1)
      expect(probes[0]?.content).toBe("host bytes")
    } finally {
      rmSync(seededDir, { recursive: true, force: true })
    }
  })

  it("#given built-in skills without an on-disk path #when the skills contribute #then the report names the skipped count once", async () => {
    // given
    const seededDir = mkdtempSync(join(tmpdir(), "oqa-t27-skills-builtin-"))
    const skillDir = join(seededDir, ".claude", "skills", "oqa-probe-skill")
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, "SKILL.md"), SKILL_BODY)
    const ctx = createFakeV2Context()
    const reports: string[] = []
    try {
      // when
      await contribute(ctx, { skillDirectory: seededDir, onSkippedSkill: (detail) => reports.push(detail) })

      // then
      expect(reports).toHaveLength(1)
      expect(reports[0]).toContain("skipped")
      expect(await listedSkillIds(ctx)).toContain("oqa-probe-skill")
    } finally {
      rmSync(seededDir, { recursive: true, force: true })
    }
  })

  it("#given a disabled skill #when the skills contribute #then the disabled skill stays out", async () => {
    // given
    const seededDir = mkdtempSync(join(tmpdir(), "oqa-t27-skills-disabled-"))
    const skillDir = join(seededDir, ".claude", "skills", "oqa-probe-skill")
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, "SKILL.md"), SKILL_BODY)
    const ctx = createFakeV2Context()
    try {
      // when
      await contribute(ctx, {
        skillDirectory: seededDir,
        disabledSkills: new Set(["oqa-probe-skill"]),
        onSkippedSkill: () => {},
      })

      // then
      expect(await listedSkillIds(ctx)).not.toContain("oqa-probe-skill")
    } finally {
      rmSync(seededDir, { recursive: true, force: true })
    }
  })

  it("#given a skill info missing path or content #when validated #then it is rejected", () => {
    // given
    const base = { id: "x", name: "x", path: "/p", content: "c" }
    // when / then
    expect(isValidSkillInfo(base)).toBe(true)
    expect(isValidSkillInfo({ ...base, path: "" })).toBe(false)
    expect(isValidSkillInfo({ ...base, content: "" })).toBe(false)
    expect(isValidSkillInfo({ ...base, id: "" })).toBe(false)
  })

  it("#given two contributing runs over the same ctx #when the second runs #then no duplicate lands", async () => {
    // given
    const seededDir = mkdtempSync(join(tmpdir(), "oqa-t27-skills-replay-"))
    const skillDir = join(seededDir, ".claude", "skills", "oqa-probe-skill")
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, "SKILL.md"), SKILL_BODY)
    const ctx = createFakeV2Context()
    try {
      // when
      await contribute(ctx, { skillDirectory: seededDir, onSkippedSkill: () => {} })
      const afterFirst = await listedSkillIds(ctx)
      await contribute(ctx, { skillDirectory: seededDir, onSkippedSkill: () => {} })

      // then
      expect(await listedSkillIds(ctx)).toEqual(afterFirst)
    } finally {
      rmSync(seededDir, { recursive: true, force: true })
    }
  })
})
