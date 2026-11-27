import { REPLACEMENT_MESSAGE } from "../../hooks/tasks-todowrite-disabler/constants"
import { TODOWRITE_DESCRIPTION } from "../../hooks/todo-description-override/description"
import type { Hooks } from "@opencode-ai/plugin"
import { expect } from "./bun-test-shim"
import { createFakeV2Context } from "./fake-v2-context"
import { createFakeV2SideEffects } from "./fake-v2-side-effects"
import { startV2Runtime } from "../runtime/start-v2-runtime"
import { resetV2ProcessStateForTesting } from "../runtime/v2-runtime-deps"
import { releaseAllPromptAsyncReservationsForTesting } from "@oh-my-opencode/utils/prompt-async-gate"
import type { OhMyOpenCodeConfig } from "../../config"
import { validatePluginConfig } from "../../config/validate"
import { updateSessionMetadata, writeSessionTodos } from "../registration/todo-store"
import { registerTodoTools, type TodoToolPlanSource } from "../registration/todo-tools"
import { createV2ClientShim } from "../client/v2-client-shim"

// Engine-level checks for the wave-3 H-REG todo rows (plan task 29): the
// host-provides gate over a seeded host tool, and the V1 hook contract
// (todoDescriptionOverride + tasksTodowriteDisabler) driven through the real
// engine's composed handlers.

let bootCounter = 0

function inlinePlanSource(): TodoToolPlanSource & { readonly recompute: () => Promise<void> } {
  const steps: Array<{ run: () => void | Promise<void> }> = []
  return {
    registerStep: (step) => {
      steps.push(step)
    },
    recompute: async () => {
      for (const step of steps) await step.run()
    },
  }
}

export async function checkHostGateKeepsStore(): Promise<void> {
  const ctx = createFakeV2Context({ tools: [{ id: "todowrite", parameters: { type: "object" } }] })
  await ctx.session.create({ id: "ses_gate" })
  const before = (await ctx.tool.list()).map((tool) => tool.id)
  const planSource = inlinePlanSource()
  await registerTodoTools(ctx, planSource)
  await planSource.recompute()

  const after = await ctx.tool.list()
  expect(after.map((tool) => tool.id)).toEqual(before)
  await writeSessionTodos(ctx, "ses_gate", [{ content: "still served", status: "pending", priority: "low" }])
  const shim = createV2ClientShim(ctx, { promptWaitPollMs: 1 })
  const todos = await shim.session.todo({ path: { id: "ses_gate" } })
  expect(todos.data?.length).toBe(1)
  expect(todos.data?.[0]?.content).toBe("still served")
  expect(await updateSessionMetadata(ctx, "ses_gate", { foreign: true })).toBeUndefined()
  const info = await ctx.session.get({ sessionID: "ses_gate" })
  expect(info.metadata?.foreign).toBe(true)
  expect(Array.isArray(info.metadata?.["omo.todos"])).toBe(true)
}

export async function checkV1HooksOnTodoNames(): Promise<void> {
  resetV2ProcessStateForTesting()
  bootCounter += 1
  const directory = `/tmp/fake-v2-t29-${String(bootCounter)}`
  const ctx = createFakeV2Context({
    location: { directory, project: { id: `prj_t29_${String(bootCounter)}`, directory, canonical: directory } },
  })
  const runtime = await startV2Runtime(ctx, {
    sideEffects: createFakeV2SideEffects(),
    engineDeps: {
      loadConfigChain: (configDirectory, environment) => {
        const validation = validatePluginConfig(configDirectory, environment)
        // This override replaces the deps' wrapped chain, so the default
        // disabled_hooks forcing does not apply. comment-checker must stay out
        // of this boot: its hook flips a process-wide module gate that later
        // test files in the same bun process depend on seeing fresh.
        const disabledHooks = new Set(validation.config.disabled_hooks ?? [])
        disabledHooks.add("comment-checker")
        const config: OhMyOpenCodeConfig = {
          ...validation.config,
          experimental: { ...validation.config.experimental, task_system: true },
          disabled_hooks: [...disabledHooks],
        }
        return { ...validation, config }
      },
    },
  })
  try {
    const tools = await ctx.tool.list()
    expect(tools.some((tool) => tool.id === "todowrite")).toBe(true)
    expect(tools.some((tool) => tool.id === "todoread")).toBe(true)
    const hooks = runtime.engine as Hooks
    const definitionOutput = { description: "placeholder", parameters: {} }
    await hooks["tool.definition"]?.({ toolID: "todowrite" }, definitionOutput)
    expect(definitionOutput.description).toBe(TODOWRITE_DESCRIPTION)
    const readOutput = { description: "placeholder", parameters: {} }
    await hooks["tool.definition"]?.({ toolID: "todoread" }, readOutput)
    expect(readOutput.description).toBe("placeholder")
    let blocked = ""
    try {
      await hooks["tool.execute.before"]?.({ tool: "todoread", sessionID: "ses_hooks", callID: "call_1" }, { args: {} })
    } catch (error) {
      blocked = error instanceof Error ? error.message : String(error)
    }
    expect(blocked).toBe(REPLACEMENT_MESSAGE)
  } finally {
    await runtime.stop()
    releaseAllPromptAsyncReservationsForTesting()
  }
}
