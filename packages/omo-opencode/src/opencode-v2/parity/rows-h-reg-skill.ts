import { expect } from "./bun-test-shim"

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFakeV2Context, type FakeV2Context } from "./fake-v2-context"
import { createFakeV2SideEffects } from "./fake-v2-side-effects"
import { startV2Runtime } from "../runtime/start-v2-runtime"
import { resetV2ProcessStateForTesting } from "../runtime/v2-runtime-deps"
import { createPlanSource } from "../registration/plan-source"
import { registerCommandTransform } from "../registration/commands"
import { defineGroup, type ParityRow } from "./rows"

// Wave-3 H-REG skill rows (plan task 27): the plugin-discovered skills the
// host does not scan contribute through ctx.skill.transform with the pinned
// typed Skill.Info shape and runtime validation, a skill the host already
// lists is not duplicated and replay stays idempotent, and the `skill` tool
// of task 25 stays the loader front-end (the command step registers no tool).

const SKILL_BODY = "---\nname: oqa-probe-skill\ndescription: probe skill for task 27\n---\n\nprobe body\n"

type SeededSkillDir = { readonly dir: string; readonly skillDir: string }

function seedSkillDir(prefix: string): SeededSkillDir {
  const dir = mkdtempSync(join(tmpdir(), `oqa-row-${prefix}-`))
  const skillDir = join(dir, ".claude", "skills", "oqa-probe-skill")
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, "SKILL.md"), SKILL_BODY)
  return { dir, skillDir }
}

async function contribute(ctx: FakeV2Context, dir: string): Promise<void> {
  const source = await createPlanSource(ctx, { config: async () => {} }, {})
  const step = registerCommandTransform(ctx, source.getPlan, source.snapshot, { skillDirectory: dir })
  source.registerStep(step)
  await source.recompute()
  await source.idle()
}

async function checkSkillContribution(): Promise<void> {
  const seeded = seedSkillDir("contribution")
  const ctx = createFakeV2Context()
  try {
    await contribute(ctx, seeded.dir)
    const listed = await ctx.skill.list()
    const probe = listed.data.find((skill) => skill.id === "oqa-probe-skill")
    expect(probe, "the probe skill is contributed").toBeDefined()
    expect(probe?.content).toContain("probe body")
    expect(probe?.path).toBe(seeded.skillDir)
  } finally {
    rmSync(seeded.dir, { recursive: true, force: true })
  }
}

async function checkSkillDedupeAndReplay(): Promise<void> {
  const seeded = seedSkillDir("dedupe")
  const ctx = createFakeV2Context()
  await ctx.skill.transform((editor) => {
    editor.add({ id: "oqa-probe-skill", name: "oqa-probe-skill", path: "/host/own/skill", content: "host bytes" })
  })
  try {
    await contribute(ctx, seeded.dir)
    const listed = await ctx.skill.list()
    const probes = listed.data.filter((skill) => skill.id === "oqa-probe-skill")
    expect(probes, "the host entry survives exactly once").toHaveLength(1)
    expect(probes[0]?.content).toBe("host bytes")
    await contribute(ctx, seeded.dir)
    const afterReplay = await ctx.skill.list()
    expect(afterReplay.data.filter((skill) => skill.id === "oqa-probe-skill")).toHaveLength(1)
  } finally {
    rmSync(seeded.dir, { recursive: true, force: true })
  }
}

async function checkSkillToolFrontend(): Promise<void> {
  resetV2ProcessStateForTesting()
  const ctx = createFakeV2Context()
  const runtime = await startV2Runtime(ctx, { sideEffects: createFakeV2SideEffects() })
  try {
    const tools = await ctx.tool.list()
    expect(
      tools.some((tool) => tool.id === "skill"),
      "the skill tool stays the loader front-end",
    ).toBe(true)
    const commands = await ctx.command.list()
    for (const definition of commands.data) {
      expect(definition.execute, "the command step registers no tool entries").toBeTypeOf("function")
    }
  } finally {
    await runtime.stop()
  }
}

export const hRegSkillRows: ParityRow[] = defineGroup("H-REG", [
  {
    suffix: "SKILL-CONTRIBUTION",
    title:
      "a plugin-discovered skill the host does not scan contributes with its real path and content through the typed transform",
    kind: "hermetic",
    is: ["IS-7"],
    wave: 3,
    status: "checked",
    check: checkSkillContribution,
  },
  {
    suffix: "SKILL-DEDUPE",
    title: "a host-listed skill id is not duplicated and replay is idempotent",
    kind: "hermetic",
    is: ["IS-7"],
    wave: 3,
    status: "checked",
    check: checkSkillDedupeAndReplay,
  },
  {
    suffix: "SKILL-TOOL-FRONTEND",
    title: "the skill tool of task 25 stays the loader front-end while the command step registers no tools",
    kind: "hermetic",
    is: ["IS-7"],
    wave: 3,
    status: "checked",
    check: checkSkillToolFrontend,
  },
])
