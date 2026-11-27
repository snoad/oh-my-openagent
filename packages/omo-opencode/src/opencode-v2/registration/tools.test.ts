import { describe, expect, it } from "bun:test"

import toolsBaseline from "../parity/fixtures/v1-baseline/tools.json"
import { createFakeV2Context } from "../parity/fake-v2-context"
import { createFakeV2SideEffects } from "../parity/fake-v2-side-effects"
import { startV2Runtime, type V2Runtime } from "../runtime/start-v2-runtime"
import { resetV2ProcessStateForTesting } from "../runtime/v2-runtime-deps"
import { releaseAllPromptAsyncReservationsForTesting } from "@oh-my-opencode/utils/prompt-async-gate"
import type { OhMyOpenCodeConfig } from "../../config"
import { validatePluginConfig } from "../../config/validate"
import { createHooks } from "../../create-hooks"
import { createHookInvocationRecorder, spyCreatedHooks } from "../hooks/hook-coverage"
import { isInteractiveBashEnabled } from "../../interactive-bash-availability"
import type { FakeToolInfo } from "../parity/fake-v2-editors"

// Shared-setup registration tests (plan task 25): the real engine boots over
// the hermetic ctx, the tool registration step runs inside the task-23
// recompute, and the fake tool editor shows the visible registry families as
// OpenCode 2 tool entries with JSON Schema inputs.

const DEFAULT_FAMILY_TOOLS = [
  "grep",
  "glob",
  "session_list",
  "session_read",
  "session_search",
  "session_info",
  "background_output",
  "background_cancel",
  "call_omo_agent",
  "task",
  "skill",
  "skill_mcp",
  "look_at",
] as const

const GATED_FAMILY_TOOLS = [
  "create_goal",
  "update_goal",
  "get_goal",
  "task_create",
  "task_get",
  "task_list",
  "task_update",
  "monitor_start",
  "monitor_stop",
  "monitor_list",
  "monitor_output",
  "team_create",
  "team_send_message",
  "team_status",
] as const

// Host built-ins the V1 host serves next to the plugin registry (never
// registered by the plugin, so they must stay host-owned on OpenCode 2).
const HOST_ONLY_TOOLS = ["read", "write", "shell", "question", "webfetch", "invalid"] as const

let bootSequence = 0

type BootResult = { readonly ctx: ReturnType<typeof createFakeV2Context>; readonly runtime: V2Runtime }

async function bootWithConfig(
  override: (config: OhMyOpenCodeConfig) => OhMyOpenCodeConfig,
  options: {
    readonly interfaceSpy?: (
      pluginInterface: ReturnType<typeof createPluginInterface>,
    ) => ReturnType<typeof createPluginInterface>
  } = {},
): Promise<BootResult> {
  bootSequence += 1
  const ctx = createFakeV2Context({
    location: {
      directory: `/tmp/fake-v2-t25-${String(bootSequence)}`,
      project: {
        id: `prj_t25_${String(bootSequence)}`,
        directory: `/tmp/fake-v2-t25-${String(bootSequence)}`,
        canonical: `/tmp/fake-v2-t25-${String(bootSequence)}`,
      },
    },
  })
  const runtime = await startV2Runtime(ctx, {
    sideEffects: createFakeV2SideEffects(),
    engineDeps: {
      loadConfigChain: (directory, environment) => {
        const validation = validatePluginConfig(directory, environment)
        return { ...validation, config: override(validation.config) }
      },
      ...(options.hooksRecorder === undefined
        ? {}
        : {
            createHooks: (hooksArgs: Parameters<typeof createHooks>[0]) =>
              spyCreatedHooks(createHooks(hooksArgs), options.hooksRecorder),
          }),
    },
  })
  return { ctx, runtime }
}

async function stopBoot(boot: BootResult): Promise<void> {
  await boot.runtime.stop()
  releaseAllPromptAsyncReservationsForTesting()
}

async function visibleToolsOf(boot: BootResult): Promise<FakeToolInfo[]> {
  return [...(await boot.ctx.tool.list())]
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return nested
    const record = nested as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return Object.fromEntries(keys.map((key) => [key, record[key]]))
  })
}

function lastBaselineParameters(id: string): unknown {
  const entries = toolsBaseline.tools.filter((tool) => tool.id === id)
  return entries[entries.length - 1]?.parameters
}

describe("registerToolTransform over the real engine", () => {
  it("#given the real engine over the hermetic ctx #when the boot completes #then every default registry family appears once with a JSON Schema input and the hashline edit tool with its config gate", async () => {
    // given
    resetV2ProcessStateForTesting()
    const boot = await bootWithConfig((config) => ({
      ...config,
      hashline_edit: true,
    }))

    try {
      // when
      const tools = await visibleToolsOf(boot)
      const byId = new Map(tools.map((tool) => [tool.id, tool]))

      // then: every default family registered exactly once
      for (const name of DEFAULT_FAMILY_TOOLS) {
        expect(byId.has(name), `${name} missing from the visible tool set`).toBe(true)
        expect(tools.filter((tool) => tool.id === name).length, `${name} duplicated`).toBe(1)
      }
      // then: hashline edit shadows nothing on the fake host and carries the input schema
      expect(byId.has("edit"), "the hashline edit tool missing").toBe(true)
      // then: every plugin tool entry carries a JSON Schema input object
      for (const name of DEFAULT_FAMILY_TOOLS) {
        const parameters = byId.get(name)?.parameters
        expect(parameters, `${name} carries no JSON Schema input`).toBeDefined()
        expect((parameters as { type?: unknown }).type, `${name} input is not an object schema`).toBe("object")
        expect((parameters as { properties?: unknown }).properties, `${name} input has no properties`).toBeDefined()
      }
      // then: replaced host tools are updated, not duplicated (grep, glob, skill exist on the fake host)
      expect(stableJson(byId.get("grep")?.parameters)).toBe(stableJson(lastBaselineParameters("grep")))
      expect(stableJson(byId.get("glob")?.parameters)).toBe(stableJson(lastBaselineParameters("glob")))
      expect(stableJson(byId.get("task")?.parameters)).toBe(stableJson(lastBaselineParameters("task")))
      // then: the replaced host tool carries no declared output schema (the
      // host would reject the codec's { content } return otherwise)
      const updated = byId.get("grep") as { output?: unknown } | undefined
      expect(updated?.output).toBeUndefined()
      // then: host-only names stay untouched by the plugin
      for (const name of HOST_ONLY_TOOLS) {
        expect(tools.filter((tool) => tool.id === name).length, `${name} must stay host-owned`).toBeLessThan(2)
      }
    } finally {
      await stopBoot(boot)
    }
  })

  it("#given the config gates for goal, task system, monitor and team mode #when the boot completes #then the gated families are visible", async () => {
    // given
    resetV2ProcessStateForTesting()
    const boot = await bootWithConfig((config) => ({
      ...config,
      goal: { ...config.goal, enabled: true },
      experimental: { ...config.experimental, task_system: true },
      monitor: { ...config.monitor, enabled: true },
      team_mode: { ...config.team_mode, enabled: true },
    }))

    try {
      // when
      const tools = await visibleToolsOf(boot)
      const ids = new Set(tools.map((tool) => tool.id))

      // then
      for (const name of GATED_FAMILY_TOOLS) {
        expect(ids.has(name), `gated tool ${name} missing`).toBe(true)
      }
    } finally {
      await stopBoot(boot)
    }
  })

  it("#given a registered session_list tool #when its V2 execute runs against the hermetic session store #then the result carries the V1 string as text content", async () => {
    // given
    resetV2ProcessStateForTesting()
    const boot = await bootWithConfig((config) => config)

    try {
      const tools = await visibleToolsOf(boot)
      const sessionList = tools.find((tool) => tool.id === "session_list")
      expect(sessionList, "session_list registered").toBeDefined()
      const execute = (sessionList as unknown as { execute?: (input: unknown, context: unknown) => Promise<unknown> })
        .execute
      expect(typeof execute, "the registered entry carries execute").toBe("function")

      // when
      const result = (await execute?.(
        { limit: 1 },
        {
          sessionID: "ses_tool_exec",
          agent: "build",
          messageID: "msg_tool_exec",
          id: "call_tool_exec",
          signal: new AbortController().signal,
        },
      )) as { content?: string }

      // then
      expect(typeof result.content).toBe("string")
      expect(result.content?.length ?? 0).toBeGreaterThan(0)
    } finally {
      await stopBoot(boot)
    }
  })

  it("#given the real engine #when the boot completes #then the snippet refresh ran the todo description override once per visible tool", async () => {
    // given
    resetV2ProcessStateForTesting()
    const recorder = createHookInvocationRecorder()
    const boot = await bootWithConfig((config) => config, { hooksRecorder: recorder })

    try {
      // when
      const tools = await visibleToolsOf(boot)
      const hostOnly = new Set<string>(HOST_ONLY_TOOLS)
      const registeredIds = tools.map((tool) => tool.id).filter((id) => !hostOnly.has(id))

      // then: the snippet refresh ran in complete passes over the plugin
      // registry (one call per visible tool per recompute; the recompute
      // count varies with host events, the pass size does not). The pass
      // carries the default families, the todo family (task 29: todowrite +
      // todoread register when the host lacks todowrite) and interactive_bash.
      const perPass = DEFAULT_FAMILY_TOOLS.length + 2 + (isInteractiveBashEnabled() ? 1 : 0)
      const refreshCalls = recorder.count("todoDescriptionOverride")
      expect(refreshCalls, "snippet refresh calls").toBeGreaterThanOrEqual(perPass)
      expect(refreshCalls % perPass, "complete refresh passes").toBe(0)
    } finally {
      await stopBoot(boot)
    }
  })

  it("#given the tool registration replayed after a recompute #when planSource.recompute runs again #then the visible tool set is unchanged", async () => {
    // given
    resetV2ProcessStateForTesting()
    const boot = await bootWithConfig((config) => config)

    try {
      const before = await visibleToolsOf(boot)

      // when
      await boot.runtime.planSource?.recompute()
      const after = await visibleToolsOf(boot)

      // then
      expect(stableJson(after.map((tool) => [tool.id, tool.parameters]))).toBe(
        stableJson(before.map((tool) => [tool.id, tool.parameters])),
      )
    } finally {
      await stopBoot(boot)
    }
  })

  it("#given the tmux availability gate #when the boot completes #then interactive_bash visibility matches the V1 gate", async () => {
    // given
    resetV2ProcessStateForTesting()
    const boot = await bootWithConfig((config) => config)

    try {
      // when
      const tools = await visibleToolsOf(boot)
      const present = tools.some((tool) => tool.id === "interactive_bash")

      // then
      expect(present).toBe(isInteractiveBashEnabled())
    } finally {
      await stopBoot(boot)
    }
  })
})
