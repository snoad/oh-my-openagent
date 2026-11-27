import { describe, expect, it } from "bun:test"

import { isGlobToolPattern, permissionRulesOfV1Agent, permissionStep, unmappedGlobPatternsOfPlan } from "./permissions"
import { EMPTY_PLAN, type PlanAgentConfig, type RegistrationPlan } from "./registration-plan"

// Unit tests for the V1 -> V2 permission projection (plan task 27): the
// documented action correspondence per rule, the every-agent global tool
// rules after the per-agent rules, the trailing wildcard allow, the glob
// patterns reported as unmapped while the expressible rules still apply, and
// the permission step reporting each distinct pattern once.

describe("permissionRulesOfV1Agent", () => {
  it("#given the documented V1 permission keys #when projected #then the correspondence holds per rule", () => {
    // given
    const entry: PlanAgentConfig = {
      permission: { bash: "allow", task: "deny", write: "ask", patch: "ask", webfetch: "allow", "mcp.use": "allow" },
    }
    // when
    const { rules } = permissionRulesOfV1Agent(entry, {})
    // then: write and patch both govern the single edit action; the first
    // occurrence wins, so one edit rule survives
    expect(rules).toEqual([
      { action: "shell", resource: "*", effect: "allow" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "ask" },
      { action: "webfetch", resource: "*", effect: "allow" },
      { action: "mcp.use", resource: "*", effect: "allow" },
      { action: "*", resource: "*", effect: "allow" },
    ])
  })

  it("#given scoped V1 bash rules #when projected #then each scope becomes a subagent-style resource rule", () => {
    // given
    const entry: PlanAgentConfig = { permission: { bash: { "git *": "allow", "rm -rf *": "deny" } } }
    // when
    const { rules } = permissionRulesOfV1Agent(entry, {})
    // then
    expect(rules.slice(0, 2)).toEqual([
      { action: "shell", resource: "git *", effect: "allow" },
      { action: "shell", resource: "rm -rf *", effect: "deny" },
    ])
    expect(rules.at(-1)).toEqual({ action: "*", resource: "*", effect: "allow" })
  })

  it("#given a per-agent tools map and a global tools map #when projected #then the global rules land after the per-agent rules and before the wildcard allow", () => {
    // given
    const entry: PlanAgentConfig = { tools: { grep: true, read: false } }
    const globalTools = { teammate: false, skill: true }
    // when
    const { rules } = permissionRulesOfV1Agent(entry, globalTools)
    // then
    expect(rules).toEqual([
      { action: "grep", resource: "*", effect: "allow" },
      { action: "read", resource: "*", effect: "deny" },
      { action: "skill", resource: "*", effect: "allow" },
      { action: "teammate", resource: "*", effect: "deny" },
      { action: "*", resource: "*", effect: "allow" },
    ])
  })

  it("#given glob tool patterns #when projected #then the patterns are unmapped while the exact rules still apply", () => {
    // given
    const entry: PlanAgentConfig = { tools: { grep: true, "task_*": false } }
    const globalTools = { "grep_app_*": false, teammate: false }
    // when
    const { rules, unmapped } = permissionRulesOfV1Agent(entry, globalTools)
    // then
    expect(unmapped).toEqual(["task_*", "grep_app_*"])
    expect(rules.some((rule) => rule.action === "grep" && rule.effect === "allow")).toBe(true)
    expect(rules.some((rule) => rule.action === "teammate" && rule.effect === "deny")).toBe(true)
    expect(rules.some((rule) => rule.action === "task_*")).toBe(false)
    expect(rules.some((rule) => rule.action === "grep_app_*")).toBe(false)
    expect(rules.at(-1)).toEqual({ action: "*", resource: "*", effect: "allow" })
  })

  it("#given a duplicated rule pair #when projected #then first match wins", () => {
    // given
    const entry: PlanAgentConfig = { permission: { bash: "allow", write: "deny" }, tools: { write: true } }
    // when
    const { rules } = permissionRulesOfV1Agent(entry, {})
    // then
    expect(rules.filter((rule) => rule.action === "edit")).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
  })
})

describe("unmapped pattern collection", () => {
  it("#given a plan with global and per-agent glob patterns #when collected #then each distinct pattern appears once", () => {
    // given
    const plan: RegistrationPlan = {
      ...EMPTY_PLAN,
      tools: { "grep_app_*": false },
      agents: {
        added: { "Sisyphus - ultraworker": { tools: { "task_*": false, "grep_app_*": false } } },
        modified: {},
        removed: [],
      },
    }
    // when
    const patterns = unmappedGlobPatternsOfPlan(plan)
    // then
    expect(patterns).toEqual(["grep_app_*", "task_*"])
  })

  it("#given no plan #when collected #then nothing is reported", () => {
    // given / when
    const patterns = unmappedGlobPatternsOfPlan(undefined)
    // then
    expect(patterns).toEqual([])
  })
})

describe("permissionStep reporting", () => {
  it("#given a plan with unmappable patterns #when the step runs twice #then each distinct pattern is reported once", async () => {
    // given
    const plan: RegistrationPlan = {
      ...EMPTY_PLAN,
      tools: { "task_*": false, "grep_app_*": false },
      agents: { added: {}, modified: {}, removed: [] },
    }
    const reported: string[] = []
    const step = permissionStep({ onUnmapped: (pattern) => reported.push(pattern) })

    // when
    await step.run({ plan } as Parameters<typeof step.run>[0])
    await step.run({ plan } as Parameters<typeof step.run>[0])

    // then
    expect(reported.sort()).toEqual(["grep_app_*", "task_*"])
  })
})

describe("isGlobToolPattern", () => {
  it("#given V1 style patterns and exact names #when classified #then only patterns are glob", () => {
    // given / when / then
    expect(isGlobToolPattern("task_*")).toBe(true)
    expect(isGlobToolPattern("grep_app_*")).toBe(true)
    expect(isGlobToolPattern("teammate")).toBe(false)
    expect(isGlobToolPattern("todowrite")).toBe(false)
  })
})
