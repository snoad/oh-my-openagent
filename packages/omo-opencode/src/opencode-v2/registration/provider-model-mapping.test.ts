import { describe, expect, it } from "bun:test"

import {
  defaultModelToString,
  mergeModelsIntoProviders,
  providerListToV1,
  providerRecordsToV1,
} from "./provider-model-mapping"
import type { ProviderSnapshotValue } from "./snapshot-inputs"

const records: ProviderSnapshotValue = [
  {
    provider: { id: "anthropic", name: "Anthropic" },
    models: [
      { id: "m1", modelID: "claude-x", providerID: "anthropic", name: "Claude X" },
      { id: "m2", modelID: "claude-y", providerID: "anthropic", name: "Claude Y" },
    ],
  },
]

describe("provider and model mapping to the V1 provider map", () => {
  it("#given recorded provider records with models #when mapped #then every model lands keyed by model id", () => {
    // given / when
    const map = providerRecordsToV1(records)

    // then
    expect(map["anthropic"]?.name).toBe("Anthropic")
    expect(map["anthropic"]?.models?.["claude-x"]).toEqual({ id: "claude-x", name: "Claude X" })
    expect(map["anthropic"]?.models?.["claude-y"]).toEqual({ id: "claude-y", name: "Claude Y" })
  })

  it("#given a bare provider list without models #when mapped #then the provider entries carry empty model maps", () => {
    // given / when
    const map = providerListToV1([{ id: "openai", name: "OpenAI" }])

    // then
    expect(map["openai"]).toEqual({ name: "OpenAI", models: {} })
  })

  it("#given models from the model source #when merged #then they land on their provider without erasing recorded models", () => {
    // given
    const map = providerRecordsToV1(records)
    mergeModelsIntoProviders(map, [
      { id: "m3", modelID: "gpt-6", providerID: "openai", name: "GPT-6" },
      { id: "m4", modelID: "claude-x", providerID: "anthropic", name: "Claude X Renamed" },
    ])

    // when / then
    expect(map["anthropic"]?.models?.["claude-x"]).toEqual({ id: "claude-x", name: "Claude X Renamed" })
    expect(map["anthropic"]?.models?.["claude-y"]).toEqual({ id: "claude-y", name: "Claude Y" })
    expect(map["openai"]?.models?.["gpt-6"]).toEqual({ id: "gpt-6", name: "GPT-6" })
  })

  it("#given a default model selection #when mapped #then the V1 model string joins provider and model id", () => {
    // given / when / then
    expect(defaultModelToString({ providerID: "anthropic", modelID: "claude-x" })).toBe("anthropic/claude-x")
  })
})
