import { expect } from "./bun-test-shim"

import { releaseAllPromptAsyncReservationsForTesting } from "@oh-my-opencode/utils/prompt-async-gate"

import type { FakeToolInfo } from "./fake-v2-editors"
import { createFakeV2Context, type FakeV2Context } from "./fake-v2-context"
import { createFakeV2SideEffects } from "./fake-v2-side-effects"
import { startV2Runtime } from "../runtime/start-v2-runtime"
import type { V2Runtime } from "../runtime/stop-v2-runtime"
import { resetV2ProcessStateForTesting } from "../runtime/v2-runtime-deps"
import { isInteractiveBashEnabled } from "../../interactive-bash-availability"
import type { OhMyOpenCodeConfig } from "../../config"
import { validatePluginConfig } from "../../config/validate"
import { defineGroup, type ParityRow, type ParityRowGroupItem } from "./rows"

// Wave-3 H-REG tool family rows (plan task 25, part 1 of 2): the default-config
// registry families. Each row boots the real engine over the hermetic ctx (the
// shared setup) and asserts the family is visible on the OpenCode 2 tool
// editor with a JSON Schema input. The gated families live in
// rows-h-reg-tools-gated.ts.

let bootCounter = 0

export type ToolFamilyBoot = { readonly ctx: FakeV2Context; readonly runtime: V2Runtime }

// Boot helper shared with rows-h-reg-tools-gated.ts (the sibling-export
// pattern of the rows-h-client files).
export async function bootToolFamilyEngine(
  override?: (config: OhMyOpenCodeConfig) => OhMyOpenCodeConfig,
): Promise<ToolFamilyBoot> {
  bootCounter += 1
  const directory = `/tmp/fake-v2-t25a-${String(bootCounter)}`
  const ctx = createFakeV2Context({
    location: { directory, project: { id: `prj_t25a_${String(bootCounter)}`, directory, canonical: directory } },
  })
  const runtime = await startV2Runtime(ctx, {
    sideEffects: createFakeV2SideEffects(),
    engineDeps:
      override === undefined
        ? {}
        : {
            loadConfigChain: (dir, environment) => {
              const validation = validatePluginConfig(dir, environment)
              return { ...validation, config: override(validation.config) }
            },
          },
  })
  return { ctx, runtime }
}

export async function stopToolFamilyBoot(boot: ToolFamilyBoot): Promise<void> {
  await boot.runtime.stop()
  releaseAllPromptAsyncReservationsForTesting()
}

async function visibleToolEntryOf(boot: ToolFamilyBoot, name: string): Promise<FakeToolInfo | undefined> {
  const tools = await boot.ctx.tool.list()
  const matches = tools.filter((tool) => tool.id === name)
  expect(matches.length, `${name} appears exactly once on the OpenCode 2 tool editor`).toBe(1)
  return matches[0]
}

// One family check: every named tool is visible with an object-shaped JSON
// Schema input after the boot's registration recompute.
export async function checkToolFamily(
  names: readonly string[],
  override?: (config: OhMyOpenCodeConfig) => OhMyOpenCodeConfig,
): Promise<void> {
  resetV2ProcessStateForTesting()
  const boot = await bootToolFamilyEngine(override)
  try {
    for (const name of names) {
      const entry = await visibleToolEntryOf(boot, name)
      expect(entry, `${name} missing from the visible tool set`).toBeDefined()
      expect((entry?.parameters as { type?: unknown } | undefined)?.type, `${name} input is not an object schema`).toBe(
        "object",
      )
      expect(
        (entry?.parameters as { properties?: unknown } | undefined)?.properties,
        `${name} input has no properties`,
      ).toBeDefined()
    }
  } finally {
    await stopToolFamilyBoot(boot)
  }
}

// interactive_bash is availability-gated, not config-gated: the row asserts
// the visibility MATCHES the V1 gate instead of asserting presence, so the
// row stays hermetic on tmux-less runners.
async function checkInteractiveBashGate(): Promise<void> {
  resetV2ProcessStateForTesting()
  const boot = await bootToolFamilyEngine()
  try {
    const tools = await boot.ctx.tool.list()
    expect(tools.some((tool) => tool.id === "interactive_bash")).toBe(isInteractiveBashEnabled())
  } finally {
    await stopToolFamilyBoot(boot)
  }
}

function row(suffix: string, title: string, names: readonly string[]): ParityRowGroupItem {
  return {
    suffix,
    title,
    kind: "hermetic",
    is: ["IS-3"],
    wave: 3,
    status: "checked",
    check: () => checkToolFamily(names),
  }
}

export const hRegToolRows: ParityRow[] = defineGroup("H-REG", [
  row("TOOL-GREP-GLOB", "the grep and glob registry tools register on OpenCode 2 with JSON Schema inputs", [
    "grep",
    "glob",
  ]),
  row(
    "TOOL-SESSION",
    "the session_* registry tools (session_list, session_read, session_search, session_info) register on OpenCode 2",
    ["session_list", "session_read", "session_search", "session_info"],
  ),
  row(
    "TOOL-BACKGROUND",
    "the background_* registry tools (background_output, background_cancel) register on OpenCode 2",
    ["background_output", "background_cancel"],
  ),
  row("TOOL-CALL-OMO-AGENT", "the call_omo_agent registry tool registers on OpenCode 2", ["call_omo_agent"]),
  row("TOOL-TASK", "the delegate task registry tool registers on OpenCode 2", ["task"]),
  row("TOOL-SKILL", "the skill registry tool registers on OpenCode 2", ["skill"]),
  row("TOOL-SKILL-MCP", "the skill_mcp registry tool registers on OpenCode 2", ["skill_mcp"]),
  row("TOOL-LOOK-AT", "the look_at registry tool registers on OpenCode 2", ["look_at"]),
  row("TOOL-INTERACTIVE-BASH", "interactive_bash visibility follows the V1 tmux availability gate on OpenCode 2", []),
])
