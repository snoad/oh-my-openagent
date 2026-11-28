// Skill contribution (task 27 of the opencode-v2-compat plan): the skills
// the plugin discovers from sources OpenCode 2 does not scan (the Claude
// paths, the config sources and the shared-skills bundle) are contributed to
// the host skill registry through ctx.skill.transform with the pinned
// Skill.Info shape, typed through import type and validated before the editor
// handover. Skills the host already lists keep the host entry (the host scan
// wins its own names), and built-in skills without an on-disk path are
// skipped with one log line: the Skill.Info path is a required absolute path
// and fabricating one is not honest. The `skill` tool of task 25 stays the
// loader front-end for everything the plugin serves to the model; the
// registration runs in the command step of commands.ts (skills are not
// plan-driven, so no plan-source step, reload target or snapshot domain
// exists for them). Disabled-skills filtering rides the same option surface
// the V1 pipeline uses; the tool front-end applies the plugin config on its
// own loads regardless.

import type { Skill } from "@opencode/plugin"

import { log } from "../../shared"
import { getAllSkills } from "../../features/opencode-skill-loader/skill-discovery"
import { guardReplayEditor } from "./replay-guard"

export type MutableSkillInfo = { -readonly [K in keyof Skill.Info]: Skill.Info[K] }

export type SkillRegistrationEditor = {
  list(): ReadonlyArray<{ readonly id: string }>
  add(skill: MutableSkillInfo): void
}

export type SkillRegistrationContext = {
  readonly skill: {
    readonly transform: (callback: (editor: SkillRegistrationEditor) => void) => Promise<unknown>
  }
}

export type SkillContributionOptions = {
  readonly skillDirectory?: string
  readonly disabledSkills?: ReadonlySet<string>
  readonly onSkippedSkill?: (detail: string) => void
}

const LOG_MARKER = "[opencode-v2] skill-contribution"

// The pinned schema brands (Skill.ID, Skill.Name, AbsolutePath) cannot be
// constructed hermetically; one cast per brand, the task-28 repair pattern.
function skillIdBrand(value: string): Skill.Info["id"] {
  return value as Skill.Info["id"]
}

function skillNameBrand(value: string): Skill.Info["name"] {
  return value as Skill.Info["name"]
}

function absolutePathBrand(value: string): Skill.Info["path"] {
  return value as Skill.Info["path"]
}

export function isValidSkillInfo(skill: MutableSkillInfo): boolean {
  return skill.id.length > 0 && skill.name.length > 0 && skill.path.length > 0 && skill.content.length > 0
}

async function collectContributableSkills(options: SkillContributionOptions): Promise<ReadonlyArray<MutableSkillInfo>> {
  const loaded = await getAllSkills({
    ...(options.skillDirectory === undefined ? {} : { directory: options.skillDirectory }),
    ...(options.disabledSkills === undefined ? {} : { disabledSkills: new Set(options.disabledSkills) }),
  })
  const built: MutableSkillInfo[] = []
  let skipped = 0
  for (const skill of loaded) {
    const path = skill.resolvedPath ?? skill.path
    const content = skill.definition.template
    if (path === undefined || content === "") {
      skipped += 1
      continue
    }
    const candidate: MutableSkillInfo = {
      id: skillIdBrand(skill.name),
      name: skillNameBrand(skill.name),
      path: absolutePathBrand(path),
      content,
    }
    if (!isValidSkillInfo(candidate)) {
      skipped += 1
      continue
    }
    built.push(candidate)
  }
  const detail =
    skipped === 0
      ? "no skill skipped"
      : `${String(skipped)} skill(s) skipped: no on-disk path or no content (built-ins stay on the skill tool)`
  if (options.onSkippedSkill === undefined) log(`${LOG_MARKER}: ${detail}`)
  else options.onSkippedSkill(detail)
  return built
}

// Fetches and validates the contributable skills, then adds the ones the
// host does not list yet. Replay is idempotent through the host-listed id
// check, so a recompute after a reload never duplicates an entry.
export async function contributeDiscoveredSkills(
  ctx: SkillRegistrationContext,
  options: SkillContributionOptions,
): Promise<void> {
  const skills = await collectContributableSkills(options)
  await ctx.skill.transform(
    guardReplayEditor("skill-contribution", (editor) => {
      const existing = new Set(editor.list().map((entry) => entry.id))
      for (const skill of skills) {
        if (existing.has(skill.id)) continue
        editor.add(skill)
      }
      return editor
    }),
  )
}
