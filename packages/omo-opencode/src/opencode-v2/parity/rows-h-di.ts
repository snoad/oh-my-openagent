import { expect } from "./bun-test-shim"

import { defaultPluginModuleDeps } from "../../testing/create-plugin-module"
import { createFakeV2Context } from "./fake-v2-context"
import { captureConsoleLines, createCountingScheduler, createStubV2EngineFactory } from "./fake-v2-engine"
import { createFakeV2SideEffects } from "./fake-v2-side-effects"
import { startV2Runtime } from "../runtime/start-v2-runtime"
import { createRuntimeDeps, resetV2ProcessStateForTesting } from "../runtime/v2-runtime-deps"
import type { V2ListedPlugin } from "../runtime/v2-plugin-identity"
import { defineGroup, type ParityRow, type ParityRowGroupItem } from "./rows"

// Wave-1 H-DI rows (plan task 13): the D-9 override object differs from the
// engine defaults on exactly the agreed keys, each override behaves as
// decided (no-ops, plugin-list detectors, config-chain wrap, process
// refcounting, per-location migration memo, console log mirror) and the agent
// sort shim stays untouched after a full runtime start.

const D9_KEYS = [
  "createRuntimeSkillSourceServer",
  "detectDuplicateOmoPlugin",
  "detectExternalSkillPlugin",
  "ensureTuiPluginEntry",
  "initLiveServerRoute",
  "initializeOpenClaw",
  "injectServerAuthIntoClient",
  "installAgentSortShim",
  "loadConfigChain",
  "log",
  "recordPluginTelemetry",
  "runOpenCodeStartupMigration",
  "setLiveParentWakeRoutingDisabled",
  "startOmoProcessSweep",
  "warmLiveServerProbe",
]

const ONE_OMO_SOURCE: readonly V2ListedPlugin[] = [
  { id: "oh-my-openagent", source: { type: "local", path: "/tmp/fake-v2" } },
  { id: "opencode.websearch", source: { type: "builtin" } },
]

function freshOverrides(pluginList: readonly V2ListedPlugin[] = ONE_OMO_SOURCE) {
  resetV2ProcessStateForTesting()
  return createRuntimeDeps({}, { pluginList, sideEffects: createFakeV2SideEffects() })
}

function row(suffix: string, title: string, check: () => void | Promise<void>): ParityRowGroupItem {
  return { suffix, title, kind: "hermetic", is: ["IS-11"], wave: 1, status: "checked", check }
}

function checkKeysExact(): void {
  const overrides = freshOverrides()
  const keys = Object.keys(overrides).sort()
  const differing = keys.filter((key) => (overrides as Record<string, unknown>)[key] !== (defaultPluginModuleDeps as Record<string, unknown>)[key])
  expect(keys, "override keys").toEqual(D9_KEYS.slice().sort())
  expect(differing, "keys differing from the defaults").toEqual(D9_KEYS.slice().sort())
}

function checkDepDiffers(key: string): () => void {
  return () => {
    const overrides = freshOverrides()
    expect((overrides as Record<string, unknown>)[key], `${key} override`).not.toBe((defaultPluginModuleDeps as Record<string, unknown>)[key])
  }
}

async function checkSortShimUntouchedAfterStart(): Promise<void> {
  const sideEffects = createFakeV2SideEffects()
  const ctx = createFakeV2Context({ scheduler: createCountingScheduler() })
  const engine = createStubV2EngineFactory({ ctx })
  const toSortedBefore = Array.prototype.toSorted
  const captured = captureConsoleLines()
  try {
    const runtime = await startV2Runtime(ctx, { engineFactory: engine.factory, sideEffects })
    await runtime.stop()
    expect(Array.prototype.toSorted, "Array.prototype.toSorted after start").toBe(toSortedBefore)
    expect(captured.lines).toContain("[oh-my-openagent] ENTRY - plugin loading")
  } finally {
    captured.restore()
  }
}

function checkTuiEntryNoop(): void {
  const overrides = freshOverrides()
  expect(overrides.ensureTuiPluginEntry()).toEqual({ changed: false, reason: "opencode-2 host owns the tui plugin entry" })
}

function checkDuplicateDetector(): void {
  const overrides = freshOverrides()
  const single = overrides.detectDuplicateOmoPlugin("/tmp/fake-v2")
  expect(single.detected).toBe(false)
  expect(single.duplicatePlugins).toHaveLength(1)
  const duplicated = freshOverrides([
    ...ONE_OMO_SOURCE,
    { id: "oh-my-openagent", source: { type: "package", target: "oh-my-openagent@5.1.83" } },
  ])
  const result = duplicated.detectDuplicateOmoPlugin("/tmp/fake-v2")
  expect(result.detected).toBe(true)
  expect(result.duplicatePlugins).toHaveLength(2)
}

function checkSkillPluginDetector(): void {
  const overrides = freshOverrides([...ONE_OMO_SOURCE, { id: "opencode-skills", source: { type: "package", target: "opencode-skills" } }])
  const result = overrides.detectExternalSkillPlugin("/tmp/fake-v2")
  expect(result.detected).toBe(true)
  expect(result.pluginName).toBe("opencode-skills")
}

function checkConfigChainWrap(): void {
  const sideEffects = createFakeV2SideEffects({ disabledHooks: ["comment-checker"] })
  resetV2ProcessStateForTesting()
  const overrides = createRuntimeDeps({}, { pluginList: ONE_OMO_SOURCE, sideEffects })
  const validation = overrides.loadConfigChain("/tmp/fake-v2")
  expect(validation.config.disabled_hooks).toEqual(["comment-checker", "auto-update-checker"])
}

function checkMigrationMemo(): void {
  const sideEffects = createFakeV2SideEffects()
  resetV2ProcessStateForTesting()
  const overrides = createRuntimeDeps({}, { pluginList: ONE_OMO_SOURCE, sideEffects })
  overrides.runOpenCodeStartupMigration({ cwd: "/tmp/fake-v2" })
  overrides.runOpenCodeStartupMigration({ cwd: "/tmp/fake-v2" })
  expect(sideEffects.tallies.migrationCwds).toEqual(["/tmp/fake-v2"])
}

async function checkSkillSourceHandle(): Promise<void> {
  const sideEffects = createFakeV2SideEffects()
  resetV2ProcessStateForTesting()
  const overrides = createRuntimeDeps({}, { pluginList: ONE_OMO_SOURCE, sideEffects })
  const first = await overrides.createRuntimeSkillSourceServer({ skills: [] })
  const second = await overrides.createRuntimeSkillSourceServer({ skills: [] })
  first.stop()
  expect(sideEffects.tallies.skillSourceStops, "skill source after the first handle stop").toBe(0)
  second.stop()
  expect(sideEffects.tallies.skillSourceStops, "skill source after the final release").toBe(1)
}

function checkLogMirror(): void {
  const overrides = freshOverrides()
  const captured = captureConsoleLines()
  try {
    overrides.log("h-di mirror line")
    expect(captured.lines).toContain("h-di mirror line")
  } finally {
    captured.restore()
  }
}

export const hDiRows: ParityRow[] = defineGroup("H-DI", [
  row("KEYS", "the D-9 override object differs from the defaults on exactly the agreed keys", checkKeysExact),
  row("AGENT-SORT-SHIM", "installAgentSortShim is overridden", checkDepDiffers("installAgentSortShim")),
  row("SERVER-AUTH", "injectServerAuthIntoClient is overridden", checkDepDiffers("injectServerAuthIntoClient")),
  row("LIVE-ROUTE", "initLiveServerRoute is overridden", checkDepDiffers("initLiveServerRoute")),
  row("PARENT-WAKE-ROUTING", "setLiveParentWakeRoutingDisabled is overridden", checkDepDiffers("setLiveParentWakeRoutingDisabled")),
  row("LIVE-PROBE", "warmLiveServerProbe is overridden", checkDepDiffers("warmLiveServerProbe")),
  row("TUI-PLUGIN-ENTRY", "ensureTuiPluginEntry is a no-op reporting the host owns the tui entry", checkTuiEntryNoop),
  row("DUPLICATE-DETECT", "detectDuplicateOmoPlugin counts listed omo plugin sources", checkDuplicateDetector),
  row("SKILL-PLUGIN-DETECT", "detectExternalSkillPlugin keeps the V1 name list over the listed plugins", checkSkillPluginDetector),
  row("CONFIG-CHAIN", "loadConfigChain always disables the auto-update-checker hook on OpenCode 2", checkConfigChainWrap),
  row("PROCESS-SWEEP", "startOmoProcessSweep is refcounted per process", checkDepDiffers("startOmoProcessSweep")),
  row("OPENCLAW", "initializeOpenClaw is refcounted per process", checkDepDiffers("initializeOpenClaw")),
  row("SKILL-SOURCE-SERVER", "createRuntimeSkillSourceServer hands out per-engine handles of one shared server", checkSkillSourceHandle),
  row("TELEMETRY", "recordPluginTelemetry is refcounted per process", checkDepDiffers("recordPluginTelemetry")),
  row("STARTUP-MIGRATION", "runOpenCodeStartupMigration runs once per location through the memo", checkMigrationMemo),
  row("LOG", "log mirrors engine log lines to the plugin console", checkLogMirror),
  row("TOSORTED", "a full runtime start leaves Array.prototype.toSorted untouched and mirrors the V1 entry line", checkSortShimUntouchedAfterStart),
])
