// Request-level tool hiding (task 27 of the opencode-v2-compat plan). A V1
// tools-map entry with value false removes the tool from every affected
// agent's model request; on OpenCode 2 a deny permission rule keeps the tool
// listed, so the task-17 context hook deletes the hidden entries from
// event.tools (the 2.4.1 SessionContext.tools map) before the request
// transforms run. The V1 names can be glob patterns ("task_*"), which the V2
// permission actions cannot express (LIM-15), so the matcher implements the
// V1 wildcard matching over the request tool names here. Global false
// entries apply to every agent; an agent entry's own false entries apply when
// the request's agent id matches the plan agent's canonical id.

import { canonicalAgentKey } from "../registration/agent-v1-to-v2"
import { isGlobToolPattern } from "../registration/permissions"
import type { RegistrationPlan } from "../registration/registration-plan"

export type RequestToolFilterEvent = {
  readonly agent: string
  readonly tools: Record<string, unknown>
}

export function globToolPatternMatches(pattern: string, name: string): boolean {
  if (!isGlobToolPattern(pattern)) return pattern === name
  const source = [...pattern]
    .map((char) => {
      if (char === "*") return "[\\s\\S]*"
      if (char === "?") return "[\\s\\S]"
      return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    })
    .join("")
  return new RegExp(`^${source}$`).test(name)
}

function falseEntriesOf(tools: Readonly<Record<string, boolean>> | undefined): readonly string[] {
  if (tools === undefined) return []
  return Object.entries(tools)
    .filter(([, value]) => value === false)
    .map(([name]) => name)
}

function hiddenNamesForAgent(plan: RegistrationPlan | undefined, agent: string): readonly string[] {
  if (plan === undefined) return []
  const hidden = new Set<string>()
  for (const name of falseEntriesOf(plan.tools)) hidden.add(name)
  for (const [key, entry] of [...Object.entries(plan.agents.added), ...Object.entries(plan.agents.modified)]) {
    if (canonicalAgentKey(key) !== agent && key !== agent) continue
    for (const name of falseEntriesOf(entry.tools)) hidden.add(name)
  }
  return [...hidden]
}

export function requestToolFilterOf(
  getPlan: () => RegistrationPlan | undefined,
): (event: RequestToolFilterEvent) => void {
  return (event) => {
    const hidden = hiddenNamesForAgent(getPlan(), event.agent)
    for (const name of Object.keys(event.tools)) {
      if (hidden.some((pattern) => globToolPatternMatches(pattern, name))) delete event.tools[name]
    }
  }
}
