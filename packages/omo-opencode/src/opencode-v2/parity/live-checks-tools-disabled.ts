import { fail, pass, type LiveCheck, type LiveCheckContext, type LiveScenarioRun } from "./live-check-context"
import { requestToolsOf } from "./live-checks-tools"

// Live check L-16 (plan task 25): the sandbox omo.json disabled_tools entry
// (look_at) removes the probe tool while the control tool (grep) stays
// visible, re-asserted after the host config change through scenario e (post
// phase, the captures exist only after the plugin reload).

const DISABLED_PROBE_TOOL = "look_at"
const CONTROL_TOOL = "grep"

type ToolsVisibility = { readonly disabledPresent: boolean; readonly controlPresent: boolean; readonly found: boolean }

function toolsVisibilityOf(scenario: LiveScenarioRun): ToolsVisibility {
  const requestTools = requestToolsOf(scenario.requestsFile)
  return {
    disabledPresent: requestTools.has(DISABLED_PROBE_TOOL),
    controlPresent: requestTools.has(CONTROL_TOOL),
    found: requestTools.size > 0,
  }
}

function visibilityEvidence(label: string, visibility: ToolsVisibility): readonly string[] {
  return [
    `${label} tools capture found: ${String(visibility.found)}`,
    `${label} ${DISABLED_PROBE_TOOL} present: ${String(visibility.disabledPresent)} (must be false; the sandbox omo.json disables it)`,
    `${label} ${CONTROL_TOOL} present: ${String(visibility.controlPresent)} (must be true; the control tool stays)`,
  ]
}

export const checkDisabledToolsEffect: LiveCheck = async (ctx) => {
  const before = ctx.manifest.scenarios.a
  const after = ctx.manifest.scenarios.e
  if (before === undefined || after === undefined) {
    return fail("manifest carries no scenarios a/e", `L-16 FAIL: scenarios a/e missing.\n`)
  }
  const beforeVisibility = toolsVisibilityOf(before)
  const afterVisibility = toolsVisibilityOf(after)
  const evidence = [
    `L-16 PASS/FAIL: the sandbox omo.json disabled_tools entry (${DISABLED_PROBE_TOOL}) takes effect and survives the host config change.`,
    `scenario a sessionID (before the change): ${before.sessionID}`,
    `scenario e sessionID (after the change): ${after.sessionID}`,
    ...visibilityEvidence("before:", beforeVisibility),
    ...visibilityEvidence("after:", afterVisibility),
    "",
  ].join("\n")
  if (!beforeVisibility.found) return fail("scenario a carries no tools capture", evidence)
  if (!afterVisibility.found) return fail("scenario e carries no tools capture after the host config change", evidence)
  if (beforeVisibility.disabledPresent || afterVisibility.disabledPresent) {
    return fail(`${DISABLED_PROBE_TOOL} is visible although disabled_tools removes it`, evidence)
  }
  if (!beforeVisibility.controlPresent || !afterVisibility.controlPresent) {
    return fail(
      `${CONTROL_TOOL} is missing; the disabled_tools entry did not only remove ${DISABLED_PROBE_TOOL}`,
      evidence,
    )
  }
  return pass(
    `${DISABLED_PROBE_TOOL} stayed hidden and ${CONTROL_TOOL} stayed visible across the host config change`,
    evidence,
  )
}
