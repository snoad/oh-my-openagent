// Command registration (task 27 of the opencode-v2-compat plan): one
// recompute step, domain "command", that replays the registration plan's
// commands section (the V1 config.command the pipeline produced: plugin
// commands, system commands and the skills exposed as commands) onto the
// OpenCode 2 command editor, and contributes the plugin-discovered skills
// OpenCode 2 does not scan through ctx.skill.transform in the same step
// (skills are not plan-driven, so no skill step, no skill reload target and
// no skill snapshot domain exist; the pinned 2.4.1 CommandEditor is add-only,
// so the pristine command state is the domain list read BEFORE the transform
// and the replay tracks its own names for idempotence). Commands V1
// intercepts through command.execute.before keep their behavior through the
// task-16 prompt-hook interception: their definition funnels the user's own
// slash text back through session.prompt (command-codec.ts). The step never
// calls ctx.command.reload(): the task-23 plan source reloads the domain once
// when the step registers and afterwards only when the plan's commands
// section changed.

import { log } from "../../shared"

import { guardReplayEditor } from "./replay-guard"
import {
  isValidCommandDefinition,
  toV2CommandDefinition,
  type CommandAdmissionContext,
  type V2CommandDefinition,
} from "./command-codec"
import { contributeDiscoveredSkills, type SkillRegistrationContext } from "./skills"
import type { HostStateSnapshot } from "./host-state-snapshot"
import type { PlanCommandConfig, RegistrationPlan } from "./registration-plan"
import type { PlanStep } from "./plan-steps"

const COMMAND_STEP_ID = "command-registration"
const LOG_MARKER = "[opencode-v2] command-registration"

export type CommandRegistrationEditor = {
  add(definition: V2CommandDefinition): void
}

export type CommandRegistrationContext = CommandAdmissionContext & {
  readonly location: { readonly directory: string }
  readonly command: {
    readonly list: () => Promise<{
      readonly data: ReadonlyArray<{ readonly name: string; readonly description?: string }>
    }>
    readonly transform: (callback: (editor: CommandRegistrationEditor) => void) => Promise<unknown>
  }
  readonly skill: SkillRegistrationContext["skill"]
}

export type CommandRegistrationOptions = {
  readonly skillDirectory?: string
  readonly disabledSkills?: ReadonlySet<string>
  readonly onSkippedSkill?: (detail: string) => void
}

// The definition fingerprint decides between skip and re-add on an add-only
// editor: an unchanged command replays as nothing, a changed one re-adds (the
// host keys the registry by name; the fake editor appends, a documented fake
// deviation for the changed case).
function fingerprintOf(entry: PlanCommandConfig): string {
  return JSON.stringify([
    entry.template ?? "",
    entry.description ?? "",
    typeof entry.agent === "string" ? entry.agent : "",
  ])
}

async function replayCommandPlan(
  ctx: CommandRegistrationContext,
  plan: RegistrationPlan,
  own: Map<string, string>,
): Promise<readonly string[]> {
  const definitions = new Map<string, V2CommandDefinition>()
  const upserts: ReadonlyArray<readonly [string, PlanCommandConfig]> = [
    ...Object.entries(plan.commands.added),
    ...Object.entries(plan.commands.modified),
  ]
  for (const [name, entry] of upserts) {
    const fingerprint = fingerprintOf(entry)
    if (own.get(name) === fingerprint) continue
    definitions.set(name, await toV2CommandDefinition(ctx, name, entry))
    own.set(name, fingerprint)
  }
  if (definitions.size === 0) return []
  await ctx.command.transform(
    guardReplayEditor(COMMAND_STEP_ID, (editor) => {
      for (const [name, definition] of definitions) {
        if (!isValidCommandDefinition(definition)) continue
        editor.add(definition)
        log(`${LOG_MARKER}: registered command ${name}`)
      }
      return editor
    }),
  )
  return [...definitions.keys()]
}

export function registerCommandTransform(
  ctx: CommandRegistrationContext,
  getPlan: () => RegistrationPlan | undefined,
  snapshot: HostStateSnapshot,
  options?: CommandRegistrationOptions,
): PlanStep {
  const own = new Map<string, string>()
  let logged = false
  return {
    id: COMMAND_STEP_ID,
    domain: "command",
    run: async (input) => {
      const pristine = await ctx.command.list()
      snapshot.record({
        domain: "command",
        value: pristine.data.filter((entry) => !own.has(entry.name)),
      })
      const plan = getPlan()
      if (plan !== undefined && input.apply === true) {
        const written = await replayCommandPlan(ctx, plan, own)
        if (!logged && written.length > 0) {
          logged = true
          log(`${LOG_MARKER}: registered ${String(written.length)} plugin commands`)
        }
      }
      if (input.apply === true) {
        await contributeDiscoveredSkills(ctx, {
          skillDirectory: options?.skillDirectory ?? ctx.location.directory,
          disabledSkills: options?.disabledSkills,
          onSkippedSkill: options?.onSkippedSkill,
        })
      }
    },
  }
}
