import { beforeEach, describe, expect, test } from "bun:test"

import type { V2ListedPlugin } from "./v2-plugin-identity"
import { createFakeV2SideEffects } from "../parity/fake-v2-side-effects"
import { captureConsoleLines } from "../parity/fake-v2-engine"
import { createRuntimeDeps, resetV2ProcessStateForTesting, v2ProcessSnapshot } from "./v2-runtime-deps"
import { defaultPluginModuleDeps } from "../../testing/create-plugin-module"

// The D-9 DI override object of the OpenCode 2 runtime (plan task 13): it
// overrides exactly the agreed keys, wraps the config chain so
// auto-update-checker is always disabled (LIM-18), re-implements the plugin
// detectors over the listed OpenCode 2 plugins, memoizes the startup
// migration per directory, mirrors the log to the plugin console and
// refcounts the process-wide side effects.

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

beforeEach(() => {
  resetV2ProcessStateForTesting()
})

describe("v2 runtime deps DI override object", () => {
  test("#given the D-9 override object #when keys are compared to the defaults #then exactly the D-9 keys differ", () => {
    // given
    const overrides = createRuntimeDeps({}, { pluginList: ONE_OMO_SOURCE })

    // when
    const keys = Object.keys(overrides).sort()
    const differing = keys.filter((key) => (overrides as Record<string, unknown>)[key] !== (defaultPluginModuleDeps as Record<string, unknown>)[key])

    // then
    expect(keys).toEqual(D9_KEYS.slice().sort())
    expect(differing).toEqual(D9_KEYS.slice().sort())
  })

  test("#given the agent sort shim override #when it runs #then Array.prototype.toSorted stays untouched", () => {
    // given
    const overrides = createRuntimeDeps({}, { pluginList: ONE_OMO_SOURCE })
    const toSortedBefore = Array.prototype.toSorted

    // when
    overrides.installAgentSortShim()

    // then
    expect(Array.prototype.toSorted).toBe(toSortedBefore)
  })

  test("#given a wrapped config chain #when the engine loads config #then auto-update-checker is always in disabled_hooks", () => {
    // given
    const sideEffects = createFakeV2SideEffects({ disabledHooks: ["comment-checker"] })
    const overrides = createRuntimeDeps({}, { pluginList: ONE_OMO_SOURCE, sideEffects })

    // when
    const validation = overrides.loadConfigChain("/tmp/fake-v2")

    // then
    expect(validation.valid).toBe(true)
    expect(validation.config.disabled_hooks).toEqual(["comment-checker", "auto-update-checker"])
    expect(sideEffects.tallies.chainDirectories).toEqual(["/tmp/fake-v2"])
  })

  test("#given a wrapped config chain without user disabled_hooks #when the engine loads config #then the hook is still disabled", () => {
    // given
    const sideEffects = createFakeV2SideEffects()
    const overrides = createRuntimeDeps({}, { pluginList: ONE_OMO_SOURCE, sideEffects })

    // when
    const validation = overrides.loadConfigChain("/tmp/fake-v2")

    // then
    expect(validation.config.disabled_hooks).toEqual(["auto-update-checker"])
  })

  test("#given two listed omo plugin sources #when duplicate detection runs #then it reports the duplicate", () => {
    // given
    const twoOmoSources: readonly V2ListedPlugin[] = [
      { id: "oh-my-openagent", source: { type: "local", path: "/tmp/fake-v2" } },
      { id: "oh-my-openagent", source: { type: "package", target: "oh-my-openagent@5.1.83" } },
    ]
    const overrides = createRuntimeDeps({}, { pluginList: twoOmoSources })

    // when
    const duplicate = overrides.detectDuplicateOmoPlugin("/tmp/fake-v2")

    // then
    expect(duplicate.detected).toBe(true)
    expect(duplicate.duplicatePlugins).toHaveLength(2)
  })

  test("#given one listed omo plugin source #when duplicate detection runs #then no duplicate is reported", () => {
    // given
    const overrides = createRuntimeDeps({}, { pluginList: ONE_OMO_SOURCE })

    // when
    const duplicate = overrides.detectDuplicateOmoPlugin("/tmp/fake-v2")

    // then
    expect(duplicate.detected).toBe(false)
    expect(duplicate.duplicatePlugins).toHaveLength(1)
  })

  test("#given a listed external skill plugin #when the skill plugin detection runs #then it names the plugin", () => {
    // given
    const withSkillPlugin: readonly V2ListedPlugin[] = [
      ...ONE_OMO_SOURCE,
      { id: "opencode-skills", source: { type: "package", target: "opencode-skills" } },
    ]
    const overrides = createRuntimeDeps({}, { pluginList: withSkillPlugin })

    // when
    const skillPlugin = overrides.detectExternalSkillPlugin("/tmp/fake-v2")

    // then
    expect(skillPlugin.detected).toBe(true)
    expect(skillPlugin.pluginName).toBe("opencode-skills")
  })

  test("#given the per-directory migration memo #when the same location starts twice #then the migration runs once", () => {
    // given
    const sideEffects = createFakeV2SideEffects()
    const overrides = createRuntimeDeps({}, { pluginList: ONE_OMO_SOURCE, sideEffects })

    // when
    const first = overrides.runOpenCodeStartupMigration({ cwd: "/tmp/fake-v2" })
    const second = overrides.runOpenCodeStartupMigration({ cwd: "/tmp/fake-v2" })
    overrides.runOpenCodeStartupMigration({ cwd: "/tmp/fake-other" })

    // then
    expect(second).toBe(first)
    expect(sideEffects.tallies.migrationCwds).toEqual(["/tmp/fake-v2", "/tmp/fake-other"])
  })

  test("#given the log mirror #when the engine logs its entry line #then the line reaches the plugin console", () => {
    // given
    const overrides = createRuntimeDeps({}, { pluginList: ONE_OMO_SOURCE })
    const captured = captureConsoleLines()

    try {
      // when
      overrides.log("[oh-my-openagent] ENTRY - plugin loading", { directory: "/tmp/fake-v2" })

      // then
      expect(captured.lines).toContain("[oh-my-openagent] ENTRY - plugin loading")
    } finally {
      captured.restore()
    }
  })

  test("#given two engines sharing one skill source server #when each handle stops #then the server closes only at the final release", async () => {
    // given
    const sideEffects = createFakeV2SideEffects()
    const overrides = createRuntimeDeps({}, { pluginList: ONE_OMO_SOURCE, sideEffects })

    // when
    const first = await overrides.createRuntimeSkillSourceServer({ skills: [] })
    const second = await overrides.createRuntimeSkillSourceServer({ skills: [] })
    first.stop()

    // then
    expect(sideEffects.tallies.skillSourceStarts).toBe(1)
    expect(sideEffects.tallies.skillSourceStops).toBe(0)
    expect(v2ProcessSnapshot().skillSource).toEqual({ live: 1, started: 1, maxConcurrent: 1 })

    // when
    second.stop()

    // then
    expect(sideEffects.tallies.skillSourceStops).toBe(1)
    expect(v2ProcessSnapshot().skillSource).toEqual({ live: 0, started: 1, maxConcurrent: 0 })
  })

  test("#given caller engine deps #when createRuntimeDeps merges #then the caller override wins over the D-9 key", () => {
    // given
    const sweep = async () => {}
    const overrides = createRuntimeDeps({ startOmoProcessSweep: sweep }, { pluginList: ONE_OMO_SOURCE })

    // when / then
    expect(overrides.startOmoProcessSweep).toBe(sweep)
    expect(overrides.installAgentSortShim).toBeDefined()
  })
})
