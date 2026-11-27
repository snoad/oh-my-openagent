// MCP registration (task 26 of the opencode-v2-compat plan): one recompute
// step, domain "mcp", that replays the registration plan's mcp section (the
// V1 config.mcp diff the pipeline produced) onto the OpenCode 2 mcp editor.
// Inside the transform callback the pristine pre-edit editor value is
// recorded into the task-22 snapshot FIRST (as plain name/config pairs,
// before any edit), then every added and modified plan entry maps onto the
// pinned Mcp.ServerConfig union, passes the completeness guard and lands
// through editor.set; removed ids go through editor.remove. ctx.mcp.reload()
// is never called here: the task-23 plan source reloads the domain once when
// the step registers and afterwards only when the plan's mcp section changed.
// An entry the V2 union cannot express is skipped with one log line naming
// the server and reported through the reporter (the task-28 rule), while the
// other servers still register.

import { log } from "../../shared"

import { guardReplayEditor } from "./replay-guard"
import type { HostStateSnapshot } from "./host-state-snapshot"
import { isValidServerConfig, mcpSnapshotValueOf, toV2ServerConfig, type UnsupportedMcpReporter } from "./mcp-mapping"
import type { PlanServerConfig, PlanSection, RegistrationPlan } from "./registration-plan"
import type { PlanStep } from "./plan-steps"

const MCP_STEP_ID = "mcp-registration"
const LOG_MARKER = "[opencode-v2] mcp-registration"

// The mutable item view the host editor hands the update callbacks (the
// pinned 2.4.1 MCPEditor uses Types.DeepMutable over the schema union); the
// registration writes whole configs through set, so only the readable item
// shape matters here.
export type McpRegistrationItem = Record<string, unknown>

export type McpRegistrationEditor = {
  list(): ReadonlyArray<readonly [string, McpRegistrationItem]>
  get(name: string): McpRegistrationItem | undefined
  set(name: string, config: unknown): void
  update(name: string, update: (config: McpRegistrationItem) => void): void
  remove(name: string): void
}

export type McpRegistrationContext = {
  readonly mcp: {
    readonly transform: (callback: (editor: McpRegistrationEditor) => void) => Promise<unknown>
  }
}

export type McpRegistrationOptions = {
  // Test and QA seam for the unsupported-entry report; default is one log
  // line per distinct entry through the shared logger.
  readonly onUnsupportedEntry?: (entry: string) => void
}

// Upserts every added and modified plan entry (set overwrites, so replay is
// idempotent) and removes the removed ids. Returns the written server names.
function replayMcpPlan(
  editor: McpRegistrationEditor,
  section: PlanSection<PlanServerConfig>,
  reportUnsupported: UnsupportedMcpReporter,
): readonly string[] {
  const written: string[] = []
  const upserts: ReadonlyArray<readonly [string, PlanServerConfig]> = [
    ...Object.entries(section.added),
    ...Object.entries(section.modified),
  ]
  for (const [name, entry] of upserts) {
    const config = toV2ServerConfig(entry)
    if (config === undefined) {
      reportUnsupported(name)
      continue
    }
    if (!isValidServerConfig(config)) {
      reportUnsupported(name)
      continue
    }
    editor.set(name, config)
    written.push(name)
  }
  for (const name of section.removed) editor.remove(name)
  return written
}

// Builds the MCP recompute step; the runtime adapter registers it on the
// plan source (runtime.planSource.registerStep) right after the plan source
// exists, then runs one recompute so the servers land at startup.
export function registerMcpTransform(
  ctx: McpRegistrationContext,
  getPlan: () => RegistrationPlan | undefined,
  snapshot: HostStateSnapshot,
  options?: McpRegistrationOptions,
): PlanStep {
  const reported = new Set<string>()
  const reportUnsupported: UnsupportedMcpReporter = (entry) => {
    if (reported.has(entry)) return
    reported.add(entry)
    const message = `${LOG_MARKER}: V1 MCP server ${entry} has no OpenCode 2 definition counterpart; skipped`
    if (options?.onUnsupportedEntry === undefined) log(message, { entry })
    else options.onUnsupportedEntry(entry)
  }
  let logged = false
  return {
    id: MCP_STEP_ID,
    domain: "mcp",
    run: async () => {
      await ctx.mcp.transform(
        guardReplayEditor(MCP_STEP_ID, (editor) => {
          snapshot.record({ domain: "mcp", value: mcpSnapshotValueOf(editor) })
          const plan = getPlan()
          if (plan !== undefined) {
            const written = replayMcpPlan(editor, plan.mcp, reportUnsupported)
            if (!logged && written.length > 0) {
              logged = true
              log(`${LOG_MARKER}: registered ${String(written.length)} mcp servers: ${written.join(", ")}`)
            }
          }
          return editor
        }),
      )
    },
  }
}
