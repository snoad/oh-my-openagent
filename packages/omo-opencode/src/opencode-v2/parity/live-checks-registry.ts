import type { ParityRow } from "./rows"
import { pendingOutcome, type LiveCheck } from "./live-check-context"
import { checkNoPluginLoadError, checkPluginActive, checkPluginActiveWithin60s } from "./live-checks-plugin"
import { checkChatMessageAdmission, checkSystemTransform } from "./live-checks-session"
import { checkToolHooks } from "./live-check-tool-hooks"
import { checkEventPipeline, checkTranslatorBudget } from "./live-checks-events"
import { checkHostNotice, checkLocationEngines } from "./live-checks-host"
import { checkIsolation } from "./live-checks-isolation"

// The live check registry (plan task 20): one entry per live row id L-01..
// L-26, so no live row is ever without an owner. Rows whose owning task has
// not landed yet resolve to a pending stub with the owner as the reason;
// L-17, L-18 and L-19 are owned by other scripts and never execute here.

const CHECKS: Readonly<Record<string, LiveCheck>> = {
  "L-01": checkPluginActive,
  "L-02": checkNoPluginLoadError,
  "L-07": checkChatMessageAdmission,
  "L-08": checkSystemTransform,
  "L-09": checkToolHooks,
  "L-11": checkEventPipeline,
  "L-15": checkIsolation,
  "L-20": checkPluginActiveWithin60s,
  "L-21": checkHostNotice,
  "L-22": checkLocationEngines,
  "L-24": checkTranslatorBudget,
}

const OTHER_SCRIPT_OWNERS: Readonly<Record<string, string>> = {
  "L-17": "the TUI smoke script (plan task 37)",
  "L-18": "v2-v1-regression.sh (stays pending with --skip-v1)",
  "L-19": "the installed-tarball check (plan task 41)",
}

const PENDING_REASONS: Readonly<Record<string, string>> = {
  "L-03": "agent registration lands with plan task 24 (wave 3)",
  "L-04": "tool registration lands with plan task 25 (wave 3)",
  "L-05": "MCP registration lands with plan task 27 (wave 3)",
  "L-06": "command registration lands with plan task 27 (wave 3)",
  "L-10": "plugin grep tool parity lands with plan task 25 (wave 3)",
  "L-12":
    "idle continuation lands with plan task 31 (wave 4); its check also asserts the total fake model requests for the session stay within the scripted steps plus 2",
  "L-13": "task tool subagent parity lands with plan task 32 (wave 4)",
  "L-14": "plugin reload cleanup lands with plan task 33 (wave 4)",
  "L-16": "sandbox omo.json config effects land with plan task 28 (wave 3)",
  "L-23": "MCP secret non-disclosure lands with plan task 27 (wave 3)",
  "L-25": "explicit compaction parity lands with plan task 31 (wave 4)",
  "L-26": "background parent wake lands with plan task 32 (wave 4)",
}

export function resolveLiveCheck(row: ParityRow, wave: number): LiveCheck {
  const otherOwner = OTHER_SCRIPT_OWNERS[row.id]
  if (otherOwner !== undefined) {
    return async () => pendingOutcome(row.id, `owned by ${otherOwner}`)
  }
  const check = CHECKS[row.id]
  if (check !== undefined) return check
  const reason = PENDING_REASONS[row.id] ?? `wave ${row.wave} row; its owning task has not landed (runner wave ${wave})`
  return async () => pendingOutcome(row.id, reason)
}

export function liveRowShouldExecute(row: ParityRow, wave: number): boolean {
  return row.kind === "live" && row.wave <= wave && OTHER_SCRIPT_OWNERS[row.id] === undefined
}
