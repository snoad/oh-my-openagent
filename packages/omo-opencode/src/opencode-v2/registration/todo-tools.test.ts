import { describe, expect, it } from "bun:test"

import { releaseAllPromptAsyncReservationsForTesting } from "@oh-my-opencode/utils/prompt-async-gate"

import toolsBaseline from "../parity/fixtures/v1-baseline/tools.json"
import { createFakeV2Context, type FakeV2Context } from "../parity/fake-v2-context"
import { createFakeV2SideEffects } from "../parity/fake-v2-side-effects"
import { startV2Runtime } from "../runtime/start-v2-runtime"
import { resetV2ProcessStateForTesting } from "../runtime/v2-runtime-deps"
import { TODOWRITE_DESCRIPTION } from "../../hooks/todo-description-override/description"
import { registerTodoTools, type TodoToolPlanSource } from "./todo-tools"
import { writeSessionTodos } from "./todo-store"

// A plan-source double that applies every registered step on recompute.
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

// Todo tools tests (plan task 29): the registered argument schema equals the
// V1 built-in contract, the execute results carry the V1 result text and the
// host-provides gate registers nothing while the store substrate keeps
// serving session metadata.

type TodoExecuteContext = {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
}

type TodoExecute = (input: unknown, context: TodoExecuteContext) => Promise<{ content?: string; metadata?: unknown }>

function executeContext(sessionID: string): TodoExecuteContext {
  return { sessionID, agent: "build", messageID: "msg_todo", id: "call_todo", signal: new AbortController().signal }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return nested
    const record = nested as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return Object.fromEntries(keys.map((key) => [key, record[key]]))
  })
}

function baselineParameters(id: string): unknown {
  const entries = toolsBaseline.tools.filter((tool) => tool.id === id)
  return entries[entries.length - 1]?.parameters
}

async function registeredToolsOf(ctx: FakeV2Context): Promise<Map<string, Record<string, unknown>>> {
  const tools = await ctx.tool.list()
  return new Map(tools.map((tool) => [tool.id, tool as unknown as Record<string, unknown>]))
}

async function executeOf(ctx: FakeV2Context, name: string): Promise<TodoExecute> {
  const tools = await registeredToolsOf(ctx)
  const tool = tools.get(name)
  expect(tool, `${name} registered`).toBeDefined()
  const execute = (tool as { execute?: TodoExecute } | undefined)?.execute
  expect(typeof execute, `${name} carries execute`).toBe("function")
  return execute as TodoExecute
}

describe("registerTodoTools", () => {
  it("#given a host without todowrite #when the registration runs #then todowrite and todoread are visible with the V1 argument schema", async () => {
    // given
    const ctx = createFakeV2Context()

    // when
    const planSource = inlinePlanSource()
    await registerTodoTools(ctx, planSource)
    await planSource.recompute()

    // then
    const tools = await registeredToolsOf(ctx)
    expect(stableJson(tools.get("todowrite")?.["parameters"])).toBe(stableJson(baselineParameters("todowrite")))
    expect(tools.get("todowrite")?.["description"]).toContain("structured task list")
    expect(tools.get("todoread")).toBeDefined()
    expect(tools.get("todoread")?.["description"]).toContain("todo list")
  })

  it("#given a host that already lists todowrite #when the registration runs #then no todo tool registers and the store still serves session metadata", async () => {
    // given
    const ctx = createFakeV2Context({ tools: [{ id: "todowrite", parameters: { type: "object" } }] })
    await ctx.session.create({ id: "ses_host" })
    const before = (await ctx.tool.list()).map((tool) => tool.id)

    // when
    const planSource = inlinePlanSource()
    await registerTodoTools(ctx, planSource)
    await planSource.recompute()

    // then
    const after = await ctx.tool.list()
    expect(after.map((tool) => tool.id)).toEqual(before)
    await writeSessionTodos(ctx, "ses_host", [{ content: "kept", status: "pending", priority: "low" }])
    const info = await ctx.session.get({ sessionID: "ses_host" })
    expect(Array.isArray(info.metadata?.["omo.todos"])).toBe(true)
  })

  it("#given the captured transform replays after a host reload #when the fake host replays the tool domain #then no duplicate entries appear", async () => {
    // given
    const ctx = createFakeV2Context()
    const planSource = inlinePlanSource()
    await registerTodoTools(ctx, planSource)
    await planSource.recompute()

    // when: the host replay re-runs every captured transform over a fresh editor
    ctx.__replay("tool")

    // then: the idempotent add keeps exactly one entry per name
    const after = (await ctx.tool.list()).map((tool) => tool.id)
    expect(after.filter((id) => id === "todowrite")).toHaveLength(1)
    expect(after.filter((id) => id === "todoread")).toHaveLength(1)
  })
})

describe("registered todo tool execute", () => {
  it("#given a todowrite call #when execute runs #then the result text is the V1 JSON serialization and the store holds the todos", async () => {
    // given
    const ctx = createFakeV2Context()
    await ctx.session.create({ id: "ses_exec" })
    const planSource = inlinePlanSource()
    await registerTodoTools(ctx, planSource)
    await planSource.recompute()
    const todowrite = await executeOf(ctx, "todowrite")
    const todos = [
      { content: "first", status: "in_progress", priority: "high" },
      { content: "second", status: "completed", priority: "low" },
    ]

    // when
    const result = await todowrite({ todos }, executeContext("ses_exec"))

    // then: the V1 built-in result text and metadata contract
    const stored = [
      { content: "first", status: "in_progress", priority: "high", id: "ses_exec:0" },
      { content: "second", status: "completed", priority: "low", id: "ses_exec:1" },
    ]
    expect(result.content).toBe(JSON.stringify(stored, null, 2))
    expect(result.metadata).toEqual({ todos: stored, title: "1 todos" })
    const info = await ctx.session.get({ sessionID: "ses_exec" })
    expect(info.metadata?.["omo.todos"]).toEqual(stored)
  })

  it("#given a todoread call #when execute runs #then the result text is the stored todo list", async () => {
    // given
    const ctx = createFakeV2Context()
    await ctx.session.create({ id: "ses_read" })
    const planSource = inlinePlanSource()
    await registerTodoTools(ctx, planSource)
    await planSource.recompute()
    const stored = await writeSessionTodos(ctx, "ses_read", [
      { content: "watch me", status: "pending", priority: "medium" },
    ])
    const todoread = await executeOf(ctx, "todoread")

    // when
    const result = await todoread({}, executeContext("ses_read"))

    // then
    expect(result.content).toBe(JSON.stringify(stored, null, 2))
    expect(result.metadata).toEqual({ todos: stored })
  })

  it("#given the restored-snapshot id form #when todowrite stores it #then explicit ids survive the write", async () => {
    // given
    const ctx = createFakeV2Context()
    await ctx.session.create({ id: "ses_restore" })
    const planSource = inlinePlanSource()
    await registerTodoTools(ctx, planSource)
    await planSource.recompute()
    const todowrite = await executeOf(ctx, "todowrite")
    const restored = [{ id: "orchestrate-plan", content: "Complete ALL implementation tasks", status: "in_progress" }]

    // when
    await todowrite({ todos: restored }, executeContext("ses_restore"))

    // then
    const info = await ctx.session.get({ sessionID: "ses_restore" })
    expect(info.metadata?.["omo.todos"]).toEqual([
      { id: "orchestrate-plan", content: "Complete ALL implementation tasks", status: "in_progress", priority: "" },
    ])
  })

  it("#given the V1 ecosystem's JSON-string todos argument #when todowrite parses it #then the valid string form stores and garbage rejects", async () => {
    // given
    const ctx = createFakeV2Context()
    await ctx.session.create({ id: "ses_string" })
    const planSource = inlinePlanSource()
    await registerTodoTools(ctx, planSource)
    await planSource.recompute()
    const todowrite = await executeOf(ctx, "todowrite")

    // when: garbage and malformed JSON reject the call
    await expect(todowrite({ todos: "not json" }, executeContext("ses_bad"))).rejects.toThrow()
    await expect(todowrite({}, executeContext("ses_bad"))).rejects.toThrow()

    // then: the valid JSON string form stores
    await todowrite(
      { todos: JSON.stringify([{ content: "string form", status: "pending", priority: "low" }]) },
      executeContext("ses_string"),
    )
    const info = await ctx.session.get({ sessionID: "ses_string" })
    expect(info.metadata?.["omo.todos"]).toEqual([
      { content: "string form", status: "pending", priority: "low", id: "ses_string:0" },
    ])
  })
})

describe("todo stand-ins and the agent prompt snippets", () => {
  let bootCounter = 0

  it("#given the real engine with the todo stand-ins registered #when the plan source builds the agent prompts #then no todo snippet line is embedded while the tools carry the override description", async () => {
    // given: the full boot applies the todo step and the registry tools in
    // the same recomputes that build the agent prompts
    resetV2ProcessStateForTesting()
    bootCounter += 1
    const directory = `/tmp/fake-v2-t29b-${String(bootCounter)}`
    const ctx = createFakeV2Context({
      location: { directory, project: { id: `prj_t29b_${String(bootCounter)}`, directory, canonical: directory } },
    })
    const runtime = await startV2Runtime(ctx, { sideEffects: createFakeV2SideEffects() })

    try {
      // when: the settled boot state and one fresh recompute (the live
      // L-03 row compares the prompts before and after a host config change,
      // and snippets recorded by the registration would only render in the
      // recomputes after the recording)
      const tools = await ctx.tool.list()
      await runtime.planSource?.recompute()
      const agents = await ctx.agent.list()

      // then: the stand-ins are registered with the override text on todowrite
      const todowrite = tools.find((tool) => tool.id === "todowrite")
      expect(todowrite, "todowrite registered by the plugin").toBeDefined()
      expect(todowrite?.description).toBe(TODOWRITE_DESCRIPTION)
      expect(
        tools.some((tool) => tool.id === "todoread"),
        "todoread registered by the plugin",
      ).toBe(true)

      // then: no agent prompt carries a todo snippet line (the host-native
      // rule: present in the tool list, absent from the prompt snippets)
      expect(agents.data.length, "agents registered").toBeGreaterThan(0)
      for (const agent of agents.data) {
        const todoLines = (agent.system ?? "").split("\n").filter((line) => /^- (todo|todowrite|todoread): /.test(line))
        expect(todoLines, `agent ${agent.id} carries a todo snippet line`).toEqual([])
      }

      // then: the snippet machinery still records registry tools (a registry
      // snippet line exists somewhere, so the absence above is not vacuous)
      expect(
        agents.data.some((agent) => (agent.system ?? "").split("\n").some((line) => line.startsWith("- grep: "))),
        "a registry snippet line survives in the prompts",
      ).toBe(true)
    } finally {
      await runtime.stop()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })
})
