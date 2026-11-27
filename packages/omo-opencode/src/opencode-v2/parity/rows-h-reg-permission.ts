import {
  checkGlobalRulesOnEveryOmoAgent,
  checkHiddenToolRemovedFromRequest,
  checkPermissionCorrespondence,
  checkUnmappedReportedOnce,
} from "./rows-h-reg-permission-checks"
import { defineGroup, type ParityRow } from "./rows"

// Wave-3 H-REG permission rows (plan task 27): the registered agent items
// carry the documented correspondence (shell for bash, subagent for task,
// edit for write and patch, dotted actions verbatim) closed by the wildcard
// allow, the plan's every-agent global tool rules land on each omo agent,
// a rule OpenCode 2 cannot express (the V1 glob tool patterns) reports once
// through LIM-15 while the expressible rules still apply, and a tool an agent
// must not see at all is deleted from that agent's request tools in the
// registered task-17 context hook.
export const hRegPermissionRows: ParityRow[] = defineGroup("H-REG", [
  {
    suffix: "PERM-CORRESPONDENCE",
    title:
      "the registered ruleset holds the documented correspondence per rule with no raw V1 action name and the trailing wildcard allow",
    kind: "hermetic",
    is: ["IS-2"],
    wave: 3,
    status: "checked",
    check: checkPermissionCorrespondence,
  },
  {
    suffix: "PERM-GLOBAL-WILDCARD",
    title: "the every-agent rules and the wildcard allow land on each omo agent the plan writes",
    kind: "hermetic",
    is: ["IS-2"],
    wave: 3,
    status: "checked",
    check: checkGlobalRulesOnEveryOmoAgent,
  },
  {
    suffix: "PERM-UNMAPPED-ONCE",
    title:
      "a permission rule without an OpenCode 2 counterpart reports once with the rule while the remaining rules still apply",
    kind: "hermetic",
    is: ["IS-2"],
    wave: 3,
    status: "checked",
    check: checkUnmappedReportedOnce,
  },
  {
    suffix: "PERM-HIDDEN-TOOL",
    title:
      "a tool an agent must not see at all is deleted from the agent's request tools in the registered context hook",
    kind: "hermetic",
    is: ["IS-2"],
    wave: 3,
    status: "checked",
    check: checkHiddenToolRemovedFromRequest,
  },
])
