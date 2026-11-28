import { describe, expect, it } from "bun:test"

import { globToolPatternMatches, requestToolFilterOf, type RequestToolFilterEvent } from "./hidden-tools"
import { EMPTY_PLAN, type RegistrationPlan } from "../registration/registration-plan"

// Unit tests for the request-level tool hiding (plan task 27): the V1 glob
// matching over tool names, the global false entries deleted for every
// agent, the agent's own false entries deleted only for that agent, and an
// absent plan leaving the request untouched.

function planWith(
  tools: Record<string, boolean>,
  agentKey: string,
  agentTools: Record<string, boolean>,
): RegistrationPlan {
  return {
    ...EMPTY_PLAN,
    tools,
    agents: { added: { [agentKey]: { tools: agentTools } }, modified: {}, removed: [] },
  }
}

function eventOf(agent: string, names: readonly string[]): RequestToolFilterEvent {
  const tools: Record<string, unknown> = {}
  for (const name of names) tools[name] = { description: "d", input: {} }
  return { agent, tools }
}

describe("globToolPatternMatches", () => {
  it("#given V1 style patterns #when matched against tool names #then the wildcard and single-char semantics hold", () => {
    // given / when / then
    expect(globToolPatternMatches("task_*", "task_create")).toBe(true)
    expect(globToolPatternMatches("task_*", "task")).toBe(false)
    expect(globToolPatternMatches("task_*", "task_create_update")).toBe(true)
    expect(globToolPatternMatches("teammate", "teammate")).toBe(true)
    expect(globToolPatternMatches("teammate", "team")).toBe(false)
    expect(globToolPatternMatches("tool?", "tools")).toBe(true)
    expect(globToolPatternMatches("tool?", "toolss")).toBe(false)
    expect(globToolPatternMatches("grep.app_*", "grep.app_probe")).toBe(true)
  })
})

describe("requestToolFilterOf", () => {
  it("#given global false entries #when the filter runs #then the hidden names are deleted for every agent", () => {
    // given
    const plan = planWith({ "grep_app_*": false, teammate: false }, "Sisyphus - ultraworker", {})
    const filter = requestToolFilterOf(() => plan)
    const event = eventOf("build", ["grep_app_search", "teammate", "grep", "task"])

    // when
    filter(event)

    // then
    expect(Object.keys(event.tools).sort()).toEqual(["grep", "task"])
  })

  it("#given an agent entry with its own false entries #when the filter runs for that agent #then only that agent loses them", () => {
    // given
    const plan = planWith({}, "Sisyphus - ultraworker", { internal_probe: false })
    const filter = requestToolFilterOf(() => plan)

    // when
    const own = eventOf("sisyphus", ["internal_probe", "grep"])
    filter(own)
    const other = eventOf("build", ["internal_probe", "grep"])
    filter(other)

    // then
    expect(Object.keys(own.tools)).toEqual(["grep"])
    expect(Object.keys(other.tools).sort()).toEqual(["grep", "internal_probe"])
  })

  it("#given no plan yet #when the filter runs #then the request stays untouched", () => {
    // given
    const filter = requestToolFilterOf(() => undefined)
    const event = eventOf("build", ["grep", "task_create"])

    // when
    filter(event)

    // then
    expect(Object.keys(event.tools).sort()).toEqual(["grep", "task_create"])
  })

  it("#given a plan whose tools map carries true entries #when the filter runs #then nothing is deleted", () => {
    // given
    const plan = planWith({ skill: true }, "sisyphus", { grep: true })
    const filter = requestToolFilterOf(() => plan)
    const event = eventOf("sisyphus", ["skill", "grep"])

    // when
    filter(event)

    // then
    expect(Object.keys(event.tools).sort()).toEqual(["grep", "skill"])
  })
})
