import { expect } from "./bun-test-shim"

import expectedCommands from "./fixtures/expected/commands.json"
import { createFakeV2Context, type FakeV2Context } from "./fake-v2-context"
import { createFakeV2SideEffects } from "./fake-v2-side-effects"
import { startV2Runtime, type V2RuntimeDeps } from "../runtime/start-v2-runtime"
import type { V2Runtime } from "../runtime/stop-v2-runtime"
import { resetV2ProcessStateForTesting } from "../runtime/v2-runtime-deps"
import { validatePluginConfig } from "../../config/validate"
import type { RegistrationPlan } from "../registration/registration-plan"
import {
  toV2CommandDefinition,
  type CommandAdmissionContext,
  type CommandInvocation,
} from "../registration/command-codec"

// The check bodies of the wave-3 H-REG command rows (plan task 27): the codec
// mapping per V1 entry shape, the registered set parity against the real
// pipeline and the committed fixture, the idempotent replay, and the
// intercepted-command relay through the prompt hook. rows-h-reg-command.ts
// holds the row definitions.

type Booted = { readonly ctx: FakeV2Context; readonly runtime: V2Runtime; readonly plan: RegistrationPlan }

async function boot(): Promise<Booted> {
  resetV2ProcessStateForTesting()
  const ctx = createFakeV2Context()
  const deps: V2RuntimeDeps = {
    sideEffects: createFakeV2SideEffects(),
    engineDeps: { loadConfigChain: (directory, environment) => validatePluginConfig(directory, environment) },
  }
  const runtime = await startV2Runtime(ctx, deps)
  const plan = runtime.planSource?.getPlan()
  if (plan === undefined) throw new Error("the registration plan is missing after boot")
  return { ctx, runtime, plan }
}

async function listedCommandNames(ctx: FakeV2Context): Promise<string[]> {
  return (await ctx.command.list()).data.map((entry) => entry.name)
}

async function relayHarness(): Promise<{
  readonly ctx: CommandAdmissionContext
  readonly texts: string[]
  readonly sessionID: string
}> {
  const fake = createFakeV2Context()
  const info = await fake.session.create({ id: "ses_row_cmd" })
  const texts: string[] = []
  await fake.session.hook("prompt", (event: { prompt: { text: string } }) => {
    texts.push(event.prompt.text)
  })
  return { ctx: fake, texts, sessionID: info.id }
}

function invocationOf(sessionID: string, text: string): CommandInvocation {
  return { sessionID, prompt: { text }, delivery: "steer" } as CommandInvocation
}

export async function checkCommandDefinitions(): Promise<void> {
  const harness = await relayHarness()
  const template = await toV2CommandDefinition(harness.ctx, "review", {
    template: "Review $ARGUMENTS carefully",
    description: "Review code",
    agent: "oracle",
  })
  await template.execute(invocationOf(harness.sessionID, "/review the diff"))
  expect(harness.texts).toEqual(["Review the diff carefully"])
  expect(template.description).toBe("Review code")

  const intercepted = await toV2CommandDefinition(harness.ctx, "goal", { template: "$ARGUMENTS" })
  await intercepted.execute(invocationOf(harness.sessionID, "/goal show"))
  expect(harness.texts).toEqual(["Review the diff carefully", "/goal show"])
}

export async function checkCommandSetParity(): Promise<void> {
  const booted = await boot()
  try {
    const planNames = [...Object.keys(booted.plan.commands.added), ...Object.keys(booted.plan.commands.modified)].sort()
    const registered = (await listedCommandNames(booted.ctx)).sort()
    expect(planNames.length, "the pipeline produced commands").toBeGreaterThan(0)
    expect(registered, "the registered set equals the pipeline output").toEqual(planNames)
    expect(registered, "the registered set equals the committed fixture").toEqual([...expectedCommands])
    const intercepted = ["goal", "omo-mcp-env-grant", "stop-continuation", "ulw-execute"]
    for (const name of intercepted) {
      expect(registered, `the intercepted command ${name} is registered`).toContain(name)
    }
  } finally {
    await booted.runtime.stop()
  }
}

export async function checkCommandReplayIdempotent(): Promise<void> {
  const booted = await boot()
  try {
    const afterBoot = (await listedCommandNames(booted.ctx)).sort()
    const source = booted.runtime.planSource
    if (source === undefined) throw new Error("the plan source is missing")
    const baseAfterBoot = (await source.snapshot.get()).command
    await source.recompute()
    await source.idle()
    const afterReplay = (await listedCommandNames(booted.ctx)).sort()
    expect(afterReplay).toEqual(afterBoot)
    expect(Object.keys(baseAfterBoot), "the pristine command base stays free of the plugin's own commands").toEqual([])
  } finally {
    await booted.runtime.stop()
  }
}
