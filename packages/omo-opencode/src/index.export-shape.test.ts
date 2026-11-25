import { describe, expect, it } from "bun:test"
import pluginModule, { omoPlugin } from "./index"

type V2SetupInput = {
  readonly app?: {
    readonly name?: string
    readonly version?: string
    readonly channel?: string
  }
  readonly location?: {
    readonly directory?: string
  }
}

type V2SetupFn = (input: V2SetupInput) => Promise<unknown> | unknown

describe("oh-my-openagent plugin export shape", () => {
  it("keeps default module and named server exports aligned", () => {
    // given
    const defaultServer = pluginModule.server

    // when
    const namedServer = omoPlugin

    // then
    expect(typeof defaultServer).toBe("function")
    expect(namedServer).toBe(defaultServer)
  })

  it("exposes the OpenCode 2 id + setup entry beside the V1 server entry", async () => {
    // given
    const definition: Record<string, unknown> = pluginModule
    const setup = definition["setup"]

    // when
    if (typeof setup !== "function") return
    const setupV2 = setup as V2SetupFn
    const result = await setupV2({
      app: { name: "opencode", version: "2.3.9", channel: "stable" },
      location: { directory: "/" },
    })

    // then
    expect(definition["id"]).toBe("oh-my-openagent")
    expect(typeof definition["server"]).toBe("function")
    expect(typeof setup).toBe("function")
    expect(result).toBeUndefined()
  })
})
