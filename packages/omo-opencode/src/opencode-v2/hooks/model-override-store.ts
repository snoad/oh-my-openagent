// Per-session model override store (plan task 16 of opencode-v2-compat).
// The V1 chat.message handler can rewrite output.message.model to request a
// different model for the message it just saw. On OpenCode 2 that request
// crosses to the model resolution point through the
// experimental.model.resolve hook, so the prompt adapter records the
// requested model here and the resolve adapter consumes it on the next
// resolution for the same session. One-shot consumption keeps the override
// scoped to the message that requested it instead of leaking onto later
// requests (title generation, compaction).

export type V1SessionModelRef = { readonly providerID: string; readonly modelID: string }

const overrides = new Map<string, V1SessionModelRef>()

export function recordSessionModelOverride(sessionID: string, model: V1SessionModelRef): void {
  overrides.set(sessionID, { providerID: model.providerID, modelID: model.modelID })
}

// Returns and clears the override recorded for the session, if any.
export function consumeSessionModelOverride(sessionID: string): V1SessionModelRef | undefined {
  const model = overrides.get(sessionID)
  if (model !== undefined) overrides.delete(sessionID)
  return model
}

export function resetSessionModelOverridesForTesting(): void {
  overrides.clear()
}
