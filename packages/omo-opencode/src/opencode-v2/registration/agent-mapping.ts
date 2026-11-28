// V2 agent -> V1 AgentConfig mapping (task 22 of the opencode-v2-compat plan).
// The V2 agent carries its instructions in `system` (V1 names it `prompt`),
// the model as {providerID, id} (V1 joins them to "providerID/id"), and its
// permission ruleset, which maps onto the per-agent tools and permission maps
// through the shared correspondence in permission-rules.ts.

import type { SnapshotAgentRecord } from "./snapshot-inputs"
import { permissionRulesToV1 } from "./permission-rules"
import type { V1AgentConfigProjection } from "./v1-config-projection"

function modelRefToString(model: SnapshotAgentRecord["model"]): string | undefined {
  if (model === undefined) return undefined
  return `${model.providerID}/${model.id}`
}

export function mapAgentToV1Config(agent: SnapshotAgentRecord): V1AgentConfigProjection {
  const { tools, permission } = permissionRulesToV1(agent.permissions ?? [])
  const model = modelRefToString(agent.model)
  return {
    ...(agent.description === undefined ? {} : { description: agent.description }),
    ...(agent.system === undefined ? {} : { prompt: agent.system }),
    mode: agent.mode,
    ...(model === undefined ? {} : { model }),
    tools,
    permission,
    ...(agent.hidden === true ? { hidden: true } : {}),
  }
}
