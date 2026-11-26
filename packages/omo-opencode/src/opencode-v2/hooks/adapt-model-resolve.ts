import { consumeSessionModelOverride } from "./model-override-store"
import { sessionHookTarget } from "./adapt-prompt-hook"
import type { V2RuntimePluginContext } from "../runtime/start-v2-runtime"
import type { V2Runtime } from "../runtime/stop-v2-runtime"

// Model resolve adapter (plan task 16 of opencode-v2-compat). OpenCode 2
// runs the session "experimental.model.resolve" hook whenever the host
// resolves the model for a request; `model` is mutable but restricted to the
// same provider (the SDK keeps it a Model.Ref within one provider). The
// prompt adapter records model overrides requested by the V1 chat.message
// handler; this adapter applies them on the next resolution and drops
// cross-provider requests with one log line, attaching the evidence to the
// candidate LIM-3 entry in parity/v2-limits.ts.

export type V2ModelResolveEvent = {
  readonly sessionID: string
  readonly model: { id: string; providerID: string; variant?: string }
}

async function runModelResolve(event: V2ModelResolveEvent): Promise<void> {
  const override = consumeSessionModelOverride(event.sessionID)
  if (override === undefined) return
  if (override.providerID !== event.model.providerID) {
    console.warn(
      `[opencode-v2] dropped cross-provider model override ${override.providerID}/${override.modelID}: ` +
        `experimental.model.resolve stays within provider ${event.model.providerID} (LIM-3)`,
    )
    return
  }
  event.model.id = override.modelID
}

export async function registerModelResolveAdapter(input: {
  readonly ctx: V2RuntimePluginContext
  readonly runtime: V2Runtime
}): Promise<void> {
  const hookCtx = sessionHookTarget(input.ctx)
  await hookCtx.session.hook("experimental.model.resolve", (event: V2ModelResolveEvent) => runModelResolve(event))
}
