import { describe, expect, it } from "bun:test"

import { createFakeV2Context } from "../parity/fake-v2-context"
import { mapCommandToV1, mapMcpListEntries, mapMcpServerConfig } from "./mcp-command-mapping"

describe("mcp and command mapping to V1 shapes", () => {
  it("#given a local V2 server config #when mapped #then the V1 McpLocalConfig keeps command, environment and enabled", () => {
    // given
    const config = mapMcpServerConfig("lsp", {
      type: "local",
      command: ["bun", "run", "lsp"],
      environment: { RUST_LOG: "info", BAD: 42 },
      enabled: false,
    })

    // when / then
    expect(config).toEqual({
      type: "local",
      command: ["bun", "run", "lsp"],
      environment: { RUST_LOG: "info" },
      enabled: false,
    })
  })

  it("#given a remote V2 server config #when mapped #then the V1 McpRemoteConfig keeps the url and enabled flag", () => {
    // given
    const config = mapMcpServerConfig("context7", {
      type: "remote",
      url: "https://mcp.context7.com/mcp",
      enabled: true,
    })

    // when / then
    expect(config).toEqual({ type: "remote", url: "https://mcp.context7.com/mcp", enabled: true })
  })

  it("#given a server config with neither command nor url #when mapped #then the error names the server", () => {
    // given / when / then
    expect(() => mapMcpServerConfig("broken", { type: "remote" })).toThrow(/broken/)
  })

  it("#given domain list entries without configs #when mapped #then every server stays present as a disabled placeholder", () => {
    // given / when
    const map = mapMcpListEntries([
      { name: "websearch", status: "connected" },
      { name: "lsp", status: "pending" },
    ])

    // then
    expect(map["websearch"]).toEqual({ type: "remote", url: "", enabled: false })
    expect(map["lsp"]).toEqual({ type: "remote", url: "", enabled: false })
  })

  it("#given a V2 command definition #when mapped #then the V1 entry keeps name and description with an inert template", () => {
    // given
    const entry = mapCommandToV1({ name: "review", description: "review changes" })

    // when / then
    expect(entry).toEqual({ template: "", description: "review changes" })
    expect(mapCommandToV1({ name: "goal" })).toEqual({ template: "" })
  })

  it("#given a command registered through a transform #when the domain list answers #then the listed definition maps to the V1 entry", async () => {
    // given
    const ctx = createFakeV2Context()
    await ctx.command.transform((editor) => {
      editor.add({
        name: "review",
        description: "review changes",
        execute: async () => {},
      })
    })

    // when
    const definition = (await ctx.command.list()).data[0]

    // then
    expect(definition?.name).toBe("review")
    expect(mapCommandToV1({ name: definition?.name ?? "", description: definition?.description })).toEqual({
      template: "",
      description: "review changes",
    })
  })
})
