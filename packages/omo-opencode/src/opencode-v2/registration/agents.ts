// Agent registration (task 24): one recompute step, domain "agent", that
// replays the registration plan's agent section onto the OpenCode 2 agent
// editor. Inside the transform callback the pristine pre-edit value is
// recorded into the task-22 snapshot FIRST (the base every later diff reads),
// then every added and modified plan agent is upserted through
// editor.update(id, ...) in plan key order - the canonical order and the
// agent_order the pipeline already encoded - and removed agents go through
// editor.remove. Creation relies on the pinned host behavior that update
// inserts a missing id (no add on the 2.4.1 editor; wave-0 interim L-03
// evidence). ctx.agent.reload() is never called here: the task-23 plan source
// reloads the domain only when its plan section changed.

import { log } from "../../shared"

import { guardReplayEditor } from "./replay-guard"
import type { AgentReplayContext, AgentReplayEditor, AgentReplayItem } from "./agent-replay-types"
import { assignAgentItem, canonicalAgentKey } from "./agent-v1-to-v2"
import type { HostStateSnapshot } from "./host-state-snapshot"
import type { PlanAgentConfig, RegistrationPlan } from "./registration-plan"
import type { PlanStep } from "./plan-steps"

const AGENT_STEP_ID = "agent-registration"
const LOG_MARKER = "[opencode-v2] agent-registration"

// Records the pristine editor value before any edit. Ids this runtime created
// (the plan's added section) are filtered out: the host hands the transform a
// fresh value that contains them after a reload, while the fake editor keeps
// live mutations in place, so the filter is what keeps the recorded base free
// of the plugin's own output on both surfaces. Host agents the step only
// updated (the name_only entries) stay base material: filtering them too made
// every re-record shrink the base until their plan entries vanished (surfaced
// by the task-27 command step's extra recompute). The default the runtime
// applied itself is neutralized for the same reason.
function recordPristineAgents(
  editor: AgentReplayEditor,
  snapshot: HostStateSnapshot,
  ownIds: ReadonlySet<string>,
  ownDefault: string | undefined,
): void {
  const agents = editor.list().filter((item) => !ownIds.has(item.id))
  const reportedDefault = editor.defaultAgent?.()
  const defaultAgent = reportedDefault === undefined || reportedDefault === ownDefault ? undefined : reportedDefault
  snapshot.record({ domain: "agent", value: { agents, ...(defaultAgent === undefined ? {} : { defaultAgent }) } })
}

// Upserts every plan agent in plan key order (added then modified; the first
// write per canonical id wins, which drops the hidden config-key aliases and
// keeps one visible V2 agent per id), removes the removed ids, applies the
// plan default. Returns the created ids so the runtime can keep the recorded
// base pristine on later replays: only the added section is the plugin's own
// output. The plan's modified entries already carry the V1 key names
// (plan-diff withV1AgentNames); name_only entries rewrite only the name so a
// host agent the pipeline never edited keeps its own fields.
function replayAgentPlan(editor: AgentReplayEditor, plan: RegistrationPlan, logWrites: boolean): ReadonlySet<string> {
  const created = new Set<string>(Object.keys(plan.agents.added).map(canonicalAgentKey))
  const written = new Set<string>()
  const upserts: ReadonlyArray<readonly [string, PlanAgentConfig]> = [
    ...Object.entries(plan.agents.added),
    ...Object.entries(plan.agents.modified),
  ]
  const writes: string[] = []
  for (const [key, entry] of upserts) {
    const id = canonicalAgentKey(key)
    if (written.has(id)) continue
    written.add(id)
    editor.update(id, (item: AgentReplayItem) => assignAgentItem(item, key, entry, plan.tools))
    if (logWrites)
      writes.push(`${id}(name ${String(entry.name ?? key)}${entry.name_only === true ? " name_only" : ""})`)
  }
  for (const key of plan.agents.removed) editor.remove(canonicalAgentKey(key))
  if (plan.defaultAgent !== undefined) {
    editor.default(canonicalAgentKey(plan.defaultAgent))
  }
  if (logWrites) log(`${LOG_MARKER}: replayed ${String(writes.length)} agents: ${writes.join(", ")}`)
  return created
}

// Builds the agent recompute step; the runtime adapter registers it on the
// plan source (runtime.planSource.registerStep) right after the plan source
// exists, then runs one recompute so the agents land at startup.
export function registerAgentTransform(
  ctx: AgentReplayContext,
  getPlan: () => RegistrationPlan | undefined,
  snapshot: HostStateSnapshot,
): PlanStep {
  const ownIds = new Set<string>()
  let ownDefault: string | undefined
  let logged = false
  return {
    id: AGENT_STEP_ID,
    domain: "agent",
    run: async () => {
      await ctx.agent.transform(
        guardReplayEditor(AGENT_STEP_ID, (editor) => {
          recordPristineAgents(editor, snapshot, ownIds, ownDefault)
          const plan = getPlan()
          if (plan === undefined) return editor
          for (const id of replayAgentPlan(editor, plan, !logged)) ownIds.add(id)
          logged = true
          const applied = getPlan()?.defaultAgent
          ownDefault = applied === undefined ? undefined : canonicalAgentKey(applied)
          return editor
        }),
      )
    },
  }
}
