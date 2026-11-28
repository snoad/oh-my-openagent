import { describe, expect, it } from "bun:test"

import { releaseAllPromptAsyncReservationsForTesting } from "@oh-my-opencode/utils/prompt-async-gate"

import { createFakeV2Context, type FakeV2Context } from "../parity/fake-v2-context"
import { createFakeV2SideEffects } from "../parity/fake-v2-side-effects"
import { startV2Runtime, type V2Runtime } from "../runtime/start-v2-runtime"
import { resetV2ProcessStateForTesting } from "../runtime/v2-runtime-deps"
import { createPlanSource, type PlanSource } from "./plan-source"
import { EMPTY_PLAN } from "./registration-plan"
import { registerMcpTransform, type McpRegistrationEditor } from "./mcp"
import { isValidServerConfig, toV2ServerConfig } from "./mcp-mapping"
import type { PlanServerConfig } from "./registration-plan"

// Registration tests for the MCP transform (plan task 26): every V1 config
// variant maps onto the pinned OpenCode 2 definition, the registered set
// equals the V1 pipeline output on the same base over the real engine, and
// replay is idempotent with the recorded pre-transform value surviving a
// reload-triggered recompute.

async function editorServers(ctx: FakeV2Context): Promise<Map<string, Record<string, unknown>>> {
  const servers = new Map<string, Record<string, unknown>>()
  await ctx.mcp.transform((editor: McpRegistrationEditor) => {
    for (const [name, config] of editor.list()) servers.set(name, { ...config })
  })
  return servers
}

async function planSourceWithMcp(
  seed: (config: Record<string, unknown>) => void,
): Promise<{ readonly ctx: FakeV2Context; readonly source: PlanSource }> {
  const ctx = createFakeV2Context()
  const source = await createPlanSource(
    ctx,
    {
      config: async (config) => {
        seed(config as unknown as Record<string, unknown>)
      },
    },
    {},
  )
  return { ctx, source }
}

describe("toV2ServerConfig mapping", () => {
  it("#given a V1 builtin remote entry #when mapped #then the V2 remote keeps url, headers and oauth false and carries no disabled flag", () => {
    // given
    const entry: PlanServerConfig = {
      type: "remote",
      url: "https://mcp.exa.ai/mcp",
      enabled: true,
      headers: { Authorization: "Bearer key" },
      oauth: false,
    }
    // when
    const config = toV2ServerConfig(entry)
    // then
    expect(config).toEqual({
      type: "remote",
      url: "https://mcp.exa.ai/mcp",
      headers: { Authorization: "Bearer key" },
      oauth: false,
    })
    expect(isValidServerConfig(config as NonNullable<typeof config>)).toBe(true)
  })

  it("#given a V1 local lsp entry #when mapped #then the V2 local keeps command, cwd and environment and carries no disabled flag", () => {
    // given
    const entry: PlanServerConfig = {
      type: "local",
      command: ["node", "packages/lsp-daemon/dist/cli.js", "mcp"],
      enabled: true,
      cwd: "/repo",
      environment: { LSP_TOOLS_MCP_CWD: "/repo" },
    }
    // when
    const config = toV2ServerConfig(entry)
    // then
    expect(config).toEqual({
      type: "local",
      command: ["node", "packages/lsp-daemon/dist/cli.js", "mcp"],
      cwd: "/repo",
      environment: { LSP_TOOLS_MCP_CWD: "/repo" },
    })
  })

  it("#given a user enabled:false entry #when mapped #then the V2 definition carries disabled true and no enabled key", () => {
    // given
    const local = toV2ServerConfig({ type: "local", command: ["node", "-v"], enabled: false })
    const remote = toV2ServerConfig({ type: "remote", url: "https://user.example", enabled: false })
    // then
    expect(local).toEqual({ type: "local", command: ["node", "-v"], disabled: true })
    expect(remote).toEqual({ type: "remote", url: "https://user.example", disabled: true })
    expect(local && "enabled" in local).toBe(false)
    expect(remote && "enabled" in remote).toBe(false)
  })

  it("#given a tolerated CC-style spelling (string command, args, env alias) #when mapped #then the command array combines and the env lands as environment", () => {
    // given
    const entry: PlanServerConfig = { type: "local", command: "node", args: ["-e", "x"], env: { A: "1" } }
    // when
    const config = toV2ServerConfig(entry)
    // then
    expect(config).toEqual({ type: "local", command: ["node", "-e", "x"], environment: { A: "1" } })
  })

  it("#given a remote oauth object entry #when mapped #then the known oauth fields cross to the V2 OAuthConfig shape", () => {
    // given
    const entry: PlanServerConfig = {
      type: "remote",
      url: "https://oauth.example",
      oauth: { client_id: "cid", scope: "read", callback_port: 49259, junk: "dropped" },
    }
    // when
    const config = toV2ServerConfig(entry) as Record<string, unknown> | undefined
    // then
    expect(config?.oauth).toEqual({ client_id: "cid", scope: "read", callback_port: 49259 })
  })

  it("#given entries the V2 union cannot express #when mapped #then they come back undefined and the valid ones still map", () => {
    // given
    const unknownType: PlanServerConfig = { type: "docker", image: "mcp" }
    const commandless: PlanServerConfig = { type: "local", enabled: true }
    const urlless: PlanServerConfig = { type: "remote", enabled: true }
    // then
    expect(toV2ServerConfig(unknownType)).toBeUndefined()
    expect(toV2ServerConfig(commandless)).toBeUndefined()
    expect(toV2ServerConfig(urlless)).toBeUndefined()
    expect(toV2ServerConfig({ type: "remote", url: "https://ok.example" })).toBeDefined()
  })

  it("#given a built local entry with an empty command #when validated #then the completeness guard rejects it", () => {
    // given
    const broken = { type: "local", command: [] } as unknown as ReturnType<typeof toV2ServerConfig>
    // then
    expect(isValidServerConfig(broken as NonNullable<typeof broken>)).toBe(false)
    expect(isValidServerConfig({ type: "remote", url: "" })).toBe(false)
  })
})

describe("registerMcpTransform over the real engine", () => {
  it("#given the real engine over the hermetic ctx #when the boot completes #then the mcp editor carries exactly the plan's servers with V2 definitions", async () => {
    // given
    resetV2ProcessStateForTesting()
    const ctx = createFakeV2Context()
    const runtime: V2Runtime = await startV2Runtime(ctx, { sideEffects: createFakeV2SideEffects() })
    try {
      // when
      const plan = runtime.planSource?.getPlan()
      expect(plan).toBeDefined()
      const servers = await editorServers(ctx)

      // then: the registered set equals the V1 pipeline output on the same base
      const planNames = [...Object.keys(plan?.mcp.added ?? {}), ...Object.keys(plan?.mcp.modified ?? {})]
      expect([...servers.keys()].sort()).toEqual([...planNames].sort())
      // then: the four builtin tiers are present
      for (const name of ["websearch", "context7", "grep_app", "lsp"]) {
        expect(servers.has(name), `mcp server ${name} registered`).toBe(true)
      }
      // then: remote builtins map with oauth false and no disabled flag
      const websearch = servers.get("websearch") ?? {}
      expect(websearch["type"]).toBe("remote")
      expect(websearch["oauth"]).toBe(false)
      expect("disabled" in websearch).toBe(false)
      // then: the lsp stdio entry maps as local with its environment
      const lsp = servers.get("lsp") ?? {}
      expect(lsp["type"]).toBe("local")
      expect(Array.isArray(lsp["command"])).toBe(true)
      expect((lsp["command"] as string[]).length).toBeGreaterThan(0)
      expect(typeof lsp["environment"]).toBe("object")
    } finally {
      await runtime.stop()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  it("#given an unsupported plan entry next to a valid one #when the replay runs #then the valid server registers and the unsupported one is reported once", async () => {
    // given
    const { ctx, source } = await planSourceWithMcp((config) => {
      config["mcp"] = {
        "ok-probe": { type: "local", command: ["node", "-v"], enabled: true },
        "docker-probe": { type: "docker", image: "mcp" },
      }
    })
    const reported: string[] = []
    const step = registerMcpTransform(ctx, source.getPlan, source.snapshot, {
      onUnsupportedEntry: (entry) => reported.push(entry),
    })
    try {
      // when
      source.registerStep(step)
      await source.recompute()
      await source.idle()
      const servers = await editorServers(ctx)

      // then
      expect([...servers.keys()]).toEqual(["ok-probe"])
      expect(servers.get("ok-probe")).toEqual({ type: "local", command: ["node", "-v"] })
      expect(reported).toEqual(["docker-probe"])
    } finally {
      await source.subscription.stop()
    }
  })

  it("#given the registered servers #when the recompute settles over reload-triggered recomputes #then the server list is unchanged and the recorded base survives", async () => {
    // given
    const { ctx, source } = await planSourceWithMcp((config) => {
      config["mcp"] = {
        websearch: { type: "remote", url: "https://mcp.exa.ai/mcp", enabled: true, oauth: false },
        "cc-probe": {
          type: "local",
          command: ["node", "server.js"],
          enabled: true,
          environment: { PROBE_TOKEN: "expanded-secret" },
        },
        "user-off": { type: "remote", url: "https://user.example", enabled: false },
      }
    })
    const step = registerMcpTransform(ctx, source.getPlan, source.snapshot)
    try {
      // when
      source.registerStep(step)
      await source.recompute()
      await source.idle()
      const afterFirst = await editorServers(ctx)
      const listCount = (): number => ctx.__calls.filter((call) => call.op === "mcp.list").length
      const reloadCount = (): number => ctx.__calls.filter((call) => call.op === "mcp.reload").length
      const listAfterFirst = listCount()

      // when: the reload-triggered recomputes. The record excludes the
      // servers this runtime wrote itself, so the recorded base stays the
      // pristine empty editor state and the plan's mcp section never shifts
      // shape (the convergence contract: consecutive recomputes produce
      // deep-equal plans, so the reload chain stops).
      await source.recompute()
      await source.idle()
      await source.recompute()
      await source.idle()
      const reloadAfterSettle = reloadCount()

      // when: two settled recomputes
      await source.recompute()
      await source.idle()
      await source.recompute()
      await source.idle()

      // then: replay is idempotent, the counts stopped growing, and the
      // recorded pre-transform value survives (the ctx mcp list is never
      // re-read after the registration recorded it)
      expect(await editorServers(ctx)).toEqual(afterFirst)
      expect(listCount()).toBe(listAfterFirst)
      expect(reloadCount()).toBe(reloadAfterSettle)
      // then: the base mcp map comes from the recorded pre-transform editor
      // state with this runtime's own servers filtered out (they re-enter
      // through every replay), never from a ctx mcp re-read; the list count
      // assertion above pins that
      const base = await source.snapshot.get()
      expect(Object.keys(base.mcp).sort()).toEqual([])
      // then: the user enabled:false entry registered as disabled
      expect(afterFirst.get("user-off")).toEqual({ type: "remote", url: "https://user.example", disabled: true })
      // then: the cc-probe environment landed literally (no by-name binding on 2.4.1)
      expect(afterFirst.get("cc-probe")?.["environment"]).toEqual({ PROBE_TOKEN: "expanded-secret" })
    } finally {
      await source.subscription.stop()
    }
  })

  it("#given an empty plan #when the replay runs #then the editor is untouched", async () => {
    // given
    const { ctx, source } = await planSourceWithMcp(() => undefined)
    const step = registerMcpTransform(ctx, source.getPlan, source.snapshot)
    try {
      // when
      source.registerStep(step)
      await source.recompute()
      await source.idle()

      // then
      expect(await editorServers(ctx)).toEqual(new Map())
      expect([...Object.keys((source.getPlan() ?? EMPTY_PLAN).mcp.added)]).toEqual([])
    } finally {
      await source.subscription.stop()
    }
  })
})
