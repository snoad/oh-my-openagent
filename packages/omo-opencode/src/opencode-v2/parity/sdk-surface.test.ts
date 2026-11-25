import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "bun:test"
import * as Plugin from "@opencode/plugin/promise/plugin"
import * as TuiPlugin from "@opencode/plugin/tui/plugin"

const SDK_VERSION = "2.4.1"

function pluginPackageRoot(): string {
  const packageJsonPath = Bun.resolveSync("@opencode/plugin/package.json", import.meta.dir)
  return join(packageJsonPath, "..")
}

describe("OpenCode 2 SDK surface", () => {
  it("pins @opencode/plugin to the recorded version", () => {
    // given
    const packageJsonPath = join(pluginPackageRoot(), "package.json")

    // when
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string }

    // then
    expect(manifest.version).toBe(SDK_VERSION)
  })

  it("exposes define() as an identity function for the promise plugin surface", () => {
    // given
    const sample: Plugin.Plugin = { id: "surface-test:promise", setup: () => {} }

    // when
    const defined = Plugin.define(sample)

    // then
    expect(defined).toBe(sample)
  })

  it("exposes define() as an identity function for the tui plugin surface", () => {
    // given
    const sample: TuiPlugin.Definition = { id: "surface-test:tui", setup: () => {} }

    // when
    const defined = TuiPlugin.define(sample)

    // then
    expect(defined).toBe(sample)
  })

  it("ships zero-dependency define modules that never reach for imports or require", () => {
    // given
    const pluginRoot = pluginPackageRoot()
    const modulePaths = [join(pluginRoot, "dist", "promise", "plugin.js"), join(pluginRoot, "dist", "tui", "plugin.js")]

    for (const modulePath of modulePaths) {
      // when
      const source = readFileSync(modulePath, "utf8")

      // then
      expect(source).not.toMatch(/\bimport\b/)
      expect(source).not.toContain("require(")
    }
  })
})
