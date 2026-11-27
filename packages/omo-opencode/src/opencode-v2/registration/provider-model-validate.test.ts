import { describe, expect, it } from "bun:test"

import type { Model } from "@opencode/plugin"

import catalog from "../../features/opengateway-provider/opengateway-models.json"
import { buildModelMirror, buildProviderMirror } from "./provider-model-contributions"
import { isValidModelInfo, isValidProviderInfo } from "./provider-model-validate"

const OPENGATEWAY_PROVIDER_ID = "opengateway"

describe("provider-model completeness predicates", () => {
  it("#given items built by the production builders #when the predicates run #then both accept them", () => {
    // given
    const model = buildModelMirror(OPENGATEWAY_PROVIDER_ID, "claude-fable-5", {
      name: "Claude Fable 5",
      limit: { context: 1000000, output: 128000 },
    })
    const provider = buildProviderMirror(OPENGATEWAY_PROVIDER_ID, {
      name: "OpenGateway",
      npm: "@ai-sdk/openai-compatible",
    })

    // when / then
    expect(isValidModelInfo(model)).toBe(true)
    expect(isValidProviderInfo(provider)).toBe(true)
  })

  it("#given model items each missing one required Model.Info field #when the predicate runs #then every one is rejected", () => {
    // given: the host reads every required field below (time.released in the
    // model sort; the rest in the pickers), so each alone can crash it
    const complete = buildModelMirror(OPENGATEWAY_PROVIDER_ID, "claude-fable-5", {
      name: "Claude Fable 5",
      limit: { context: 1000000, output: 128000 },
      tool_call: true,
    })
    const { time: _time, ...withoutTime } = complete
    const { variants: _variants, ...withoutVariants } = complete
    const { cost: _cost, ...withoutCost } = complete
    const { status: _status, ...withoutStatus } = complete
    const { enabled: _enabled, ...withoutEnabled } = complete
    const broken: unknown[] = [
      withoutTime,
      withoutVariants,
      withoutCost,
      withoutStatus,
      withoutEnabled,
      { ...complete, time: { released: Number.NaN } },
      { ...complete, time: { released: "2025-01-01" } },
      { ...complete, status: "unknown" },
      { ...complete, enabled: "yes" },
      { ...complete, limit: { context: 1.5, output: 32000 } },
      { ...complete, cost: [{ input: "1", output: 2, cache: { read: 0, write: 0 } }] },
      { ...complete, cost: [{ input: 1, output: 2, cache: { read: Number.NaN, write: 0 } }] },
      { ...complete, capabilities: { tools: true, output: ["text"] } },
      { ...complete, capabilities: { tools: true, input: ["text"], output: [42] } },
    ]

    // when / then
    for (const item of broken) expect(isValidModelInfo(item)).toBe(false)
  })

  it("#given provider items missing or carrying a wrong required Provider.Info field #when the predicate runs #then each is rejected", () => {
    // given
    const complete = buildProviderMirror(OPENGATEWAY_PROVIDER_ID, { name: "OpenGateway" })
    const { activation, ...withoutActivation } = complete
    const { package: _package, ...withoutPackage } = complete
    const broken: unknown[] = [
      withoutActivation,
      withoutPackage,
      { ...complete, activation: "sometimes" },
      { ...complete, name: 7 },
    ]

    // when / then
    for (const item of broken) expect(isValidProviderInfo(item)).toBe(false)
  })

  it("#given every OpenGateway catalog entry #when the plugin builds the item the way the provider step does #then each is a complete Model.Info and passes the guard", () => {
    // given: the V1 injection keys every catalog entry under the
    // opengateway provider models map by its full catalog key
    const entries = Object.entries(catalog)
    expect(entries.length).toBeGreaterThan(0)

    // when: the built array is typed as the REAL Model.Info items the host
    // editor consumes, so a missing required field is a compile error
    const built: Model.Info[] = entries.map(([modelID, entry]) =>
      buildModelMirror(OPENGATEWAY_PROVIDER_ID, modelID, entry),
    )

    // then
    for (const item of built) {
      expect(isValidModelInfo(item)).toBe(true)
      expect(item.time.released).toBe(0)
      expect(item.status).toBe("active")
      expect(item.enabled).toBe(true)
      expect(item.providerID).toBe(OPENGATEWAY_PROVIDER_ID)
    }
    expect(built.every((item) => Number.isInteger(item.limit.context) && Number.isInteger(item.limit.output))).toBe(
      true,
    )
  })
})
