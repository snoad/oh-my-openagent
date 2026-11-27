import type { ProviderContext } from "@opencode-ai/plugin"
import type { Model, Provider, UserMessage } from "@opencode-ai/sdk"

// Honest V1 hook payload stubs for the OpenCode 2 context adapter (plan task
// 17). The V2 context hook only carries Model.Ref {id, providerID}, so the
// adapter fabricates the remaining V1 payload fields. Capabilities are
// all-true so the chat.params compatibility layer never strips host-provided
// knobs (a false value would read as "unsupported by model metadata" and
// delete temperature/topP from the request); the output limit stays large so
// the maxTokens fallback never clamps a real host value.

export type V2ModelRef = { readonly id: string; readonly providerID: string }

export function v1ModelStub(model: V2ModelRef): Model {
  return {
    id: model.id,
    providerID: model.providerID,
    api: { id: model.id, url: "", npm: "" },
    name: model.id,
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: true, image: true, video: true, pdf: true },
      output: { text: true, audio: true, image: true, video: true, pdf: true },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200_000, output: 131_072 },
    status: "active",
    options: {},
    headers: {},
  }
}

export function v1ProviderStub(providerID: string): ProviderContext {
  const info: Provider = {
    id: providerID,
    name: providerID,
    source: "config",
    env: [],
    options: {},
    models: {},
  }
  return { source: "config", info, options: {} }
}

export type V1UserMessageWithVariant = UserMessage & { variant?: string }

export function v1UserMessageStub(input: {
  readonly sessionID: string
  readonly agent: string
  readonly model: V2ModelRef
  readonly messageID?: string
}): V1UserMessageWithVariant {
  return {
    id: input.messageID ?? input.sessionID,
    sessionID: input.sessionID,
    role: "user",
    time: { created: 0 },
    agent: input.agent,
    model: { providerID: input.model.providerID, modelID: input.model.id },
  }
}
