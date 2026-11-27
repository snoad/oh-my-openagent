import { describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { releaseAllPromptAsyncReservationsForTesting } from "@oh-my-opencode/utils/prompt-async-gate"

import expectedCommands from "../parity/fixtures/expected/commands.json"
import { createFakeV2Context, type FakeV2Context } from "../parity/fake-v2-context"
import { createFakeV2SideEffects } from "../parity/fake-v2-side-effects"
import { startV2Runtime, type V2Runtime, type V2RuntimeDeps } from "../runtime/start-v2-runtime"
import { resetV2ProcessStateForTesting } from "../runtime/v2-runtime-deps"
import { createPlanSource, type PlanSource } from "./plan-source"
import { registerCommandTransform } from "./commands"
import { validatePluginConfig } from "../../config/validate"
import {
  argumentsOfInvocation,
  expandedTemplateOf,
  isInterceptedCommand,
  toV2CommandDefinition,
  type CommandAdmissionContext,
  type CommandInvocation,
} from "./command-codec"
import type { RegistrationPlan } from "./registration-plan"

// Registration tests for the command step (plan task 27): every V1 command
// entry maps onto the pinned OpenCode 2 definition with the right execute
// behavior, the registered set equals the V1 pipeline output on the same base
// and equals the committed expected fixture, replay is idempotent, the
// pristine record lands before any edit, and the plugin skills contribute
// through the same step.

async function planSourceWithCommands(): Promise<{ readonly ctx: FakeV2Context; readonly source: PlanSource }> {
  const ctx = createFakeV2Context()
  const source = await createPlanSource(ctx, { config: async () => {} }, {})
  return { ctx, source }
}

type Booted = {
  readonly ctx: FakeV2Context
  readonly runtime: V2Runtime
  readonly plan: RegistrationPlan
}

async function bootRegistered(): Promise<Booted> {
  resetV2ProcessStateForTesting()
  releaseAllPromptAsyncReservationsForTesting()
  const ctx = createFakeV2Context()
  const deps: V2RuntimeDeps = {
    sideEffects: createFakeV2SideEffects(),
    engineDeps: {
      loadConfigChain: (directory, environment) => validatePluginConfig(directory, environment),
    },
  }
  const runtime = await startV2Runtime(ctx, deps)
  const plan = runtime.planSource?.getPlan()
  if (plan === undefined) throw new Error("the plan source is missing after boot")
  return { ctx, runtime, plan }
}

async function listedCommandNames(ctx: FakeV2Context): Promise<string[]> {
  const listed = await ctx.command.list()
  return listed.data.map((entry) => entry.name)
}

function invocationOf(sessionID: string, text: string): CommandInvocation {
  return { sessionID, prompt: { text }, delivery: "steer" } as CommandInvocation
}

async function relayContext(): Promise<{
  readonly ctx: CommandAdmissionContext
  readonly received: { texts: string[]; metadatas: unknown[]; agents: unknown[] }
  readonly sessionID: string
}> {
  const fake = createFakeV2Context()
  const info = await fake.session.create({ id: "ses_cmd" })
  const received: { texts: string[]; metadatas: unknown[]; agents: unknown[] } = {
    texts: [],
    metadatas: [],
    agents: [],
  }
  await fake.session.hook("prompt", (event) => {
    received.texts.push(event.prompt.text)
    received.metadatas.push(event.metadata)
    received.agents.push(event.prompt.agents)
  })
  return { ctx: fake, received, sessionID: info.id }
}

describe("command codec mapping", () => {
  it("#given a template command with $ARGUMENTS and an agent #when executed #then the expanded template and the agent reach session.prompt", async () => {
    // given
    const { ctx, received, sessionID } = await relayContext()
    const definition = await toV2CommandDefinition(ctx, "review", {
      template: "Review $ARGUMENTS carefully",
      description: "Review code",
      agent: "oracle",
    })

    // when
    await definition.execute(invocationOf(sessionID, "/review the diff"))

    // then
    expect(received.texts).toEqual(["Review the diff carefully"])
    expect(received.agents[0]).toEqual([{ name: "oracle" }])
    expect(definition.description).toBe("Review code")
  })

  it("#given an intercepted plugin command #when executed #then the slash name reaches the prompt hook with the arguments", async () => {
    // given
    const { ctx, received, sessionID } = await relayContext()
    expect(isInterceptedCommand("goal")).toBe(true)
    const definition = await toV2CommandDefinition(ctx, "goal", { template: "$ARGUMENTS" })

    // when
    await definition.execute(invocationOf(sessionID, "/goal show"))

    // then
    expect(received.texts).toEqual(["/goal show"])
    expect(received.metadatas[0]).toEqual({ omo: { command: "goal" } })
  })

  it("#given the host stripped the slash name from the invocation #when executed #then the bare text is the arguments", async () => {
    // given
    const { ctx, received, sessionID } = await relayContext()
    const definition = await toV2CommandDefinition(ctx, "ulw-execute", { template: "$ARGUMENTS" })

    // when
    await definition.execute(invocationOf(sessionID, ".omo/plans/x.md"))

    // then
    expect(received.texts).toEqual(["/ulw-execute .omo/plans/x.md"])
  })

  it("#given two concurrent executions of the same command and session #when the relay is in flight #then only one submission lands", async () => {
    // given
    const { ctx, received, sessionID } = await relayContext()
    const definition = await toV2CommandDefinition(ctx, "stop-continuation", { template: "$ARGUMENTS" })

    // when
    const first = definition.execute(invocationOf(sessionID, "/stop-continuation"))
    const second = definition.execute(invocationOf(sessionID, "/stop-continuation"))
    await Promise.all([first, second])

    // then
    expect(received.texts).toHaveLength(1)
  })

  it("#given a different session #when the same command executes #then the relay runs again", async () => {
    // given
    const { ctx, received, sessionID } = await relayContext()
    await ctx.session.create({ id: "ses_cmd_2" })
    const definition = await toV2CommandDefinition(ctx, "goal", { template: "$ARGUMENTS" })

    // when
    await definition.execute(invocationOf(sessionID, "/goal set x"))
    await definition.execute(invocationOf("ses_cmd_2", "/goal set y"))

    // then
    expect(received.texts).toEqual(["/goal set x", "/goal set y"])
  })

  it("#given a bare template #when expanded #then the arguments substitute into every occurrence", () => {
    // given
    const template = "plan: $ARGUMENTS, verify: $ARGUMENTS"
    // when
    const expanded = expandedTemplateOf(template, "the diff")
    // then
    expect(expanded).toBe("plan: the diff, verify: the diff")
  })

  it("#given a submission without the slash name #when arguments are parsed #then the whole text is the arguments", () => {
    // given
    const invocation = invocationOf("ses_cmd", "plain text")
    // when
    const args = argumentsOfInvocation("goal", invocation)
    // then
    expect(args).toBe("plain text")
  })
})

describe("command step over the real pipeline", () => {
  it("#given the hermetic ctx and the real pipeline #when the runtime boots #then the registered names equal the plan and the committed fixture", async () => {
    // given
    const booted = await bootRegistered()
    try {
      // when
      const planNames = [
        ...Object.keys(booted.plan.commands.added),
        ...Object.keys(booted.plan.commands.modified),
      ].sort()
      const registered = (await listedCommandNames(booted.ctx)).sort()

      // then
      expect(planNames.length, "the pipeline produced commands").toBeGreaterThan(0)
      expect(registered).toEqual(planNames)
      expect(registered).toEqual([...expectedCommands])
    } finally {
      await booted.runtime.stop()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  it("#given a second recompute of the same plan #when the command step replays #then the list is unchanged and the base stays pristine", async () => {
    // given
    const booted = await bootRegistered()
    try {
      const afterFirst = await listedCommandNames(booted.ctx)
      const baseAfterFirst = (await booted.runtime.planSource?.snapshot.get()).command

      // when
      await booted.runtime.planSource?.recompute()
      await booted.runtime.planSource?.idle()

      // then
      const afterSecond = await listedCommandNames(booted.ctx)
      expect(afterSecond.sort()).toEqual(afterFirst.sort())
      expect(Object.keys(baseAfterFirst)).toEqual([])
      const baseAfterSecond = (await booted.runtime.planSource?.snapshot.get()).command
      expect(Object.keys(baseAfterSecond)).toEqual([])
    } finally {
      await booted.runtime.stop()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  it("#given a seeded claude skill directory #when the command step contributes skills #then the probe skill lands with path and content and a host-listed id is not duplicated", async () => {
    // given
    releaseAllPromptAsyncReservationsForTesting()
    const seededDir = mkdtempSync(join(tmpdir(), "oqa-t27-skills-"))
    const skillDir = join(seededDir, ".claude", "skills", "oqa-probe-skill")
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: oqa-probe-skill\ndescription: probe skill for task 27\n---\n\nprobe body\n",
    )
    const { ctx, source } = await planSourceWithCommands()
    const step = registerCommandTransform(ctx, source.getPlan, source.snapshot, { skillDirectory: seededDir })
    source.registerStep(step)
    try {
      // when
      await source.recompute()
      await source.idle()

      // then
      const listed = await ctx.skill.list()
      const probe = listed.data.find((skill) => skill.id === "oqa-probe-skill")
      expect(probe, "the probe skill is contributed").toBeDefined()
      expect(probe?.content).toContain("probe body")
      expect(probe?.path).toBe(skillDir)
      expect(listed.data.filter((skill) => skill.id === "oqa-probe-skill")).toHaveLength(1)
      await source.recompute()
      await source.idle()
      const afterReplay = await ctx.skill.list()
      expect(afterReplay.data.filter((skill) => skill.id === "oqa-probe-skill")).toHaveLength(1)
    } finally {
      rmSync(seededDir, { recursive: true, force: true })
      releaseAllPromptAsyncReservationsForTesting()
    }
  })
})
