import { describe, expect, it } from "bun:test"

import { permissionRulesToV1 } from "./permission-rules"
import type { SnapshotPermissionRule } from "./snapshot-inputs"

function rules(
  ...entries: Array<[action: string, resource: string, effect: "allow" | "deny" | "ask"]>
): SnapshotPermissionRule[] {
  return entries.map(([action, resource, effect]) => ({ action, resource, effect }))
}

describe("permission rules to V1 projection", () => {
  it("#given a shell allow rule #when mapped #then V1 bash is enabled and allowed", () => {
    // given
    const mapped = permissionRulesToV1(rules(["shell", "*", "allow"]))

    // when / then
    expect(mapped.tools).toEqual({ bash: true })
    expect(mapped.permission["bash"]).toBe("allow")
    expect(mapped.unmapped).toEqual([])
  })

  it("#given a subagent deny rule #when mapped #then V1 task is disabled and denied", () => {
    // given
    const mapped = permissionRulesToV1(rules(["subagent", "*", "deny"]))

    // when / then
    expect(mapped.tools).toEqual({ task: false })
    expect(mapped.permission["task"]).toBe("deny")
  })

  it("#given an edit deny rule #when mapped #then both V1 write and V1 patch are disabled and denied", () => {
    // given
    const mapped = permissionRulesToV1(rules(["edit", "*", "deny"]))

    // when / then
    expect(mapped.tools).toEqual({ write: false, patch: false })
    expect(mapped.permission["write"]).toBe("deny")
    expect(mapped.permission["patch"]).toBe("deny")
  })

  it("#given the dotted V2 actions #when mapped #then mcp.use, skill.use and plugin.use keep their names", () => {
    // given
    const mapped = permissionRulesToV1(
      rules(["mcp.use", "*", "ask"], ["skill.use", "*", "deny"], ["plugin.use", "*", "allow"]),
    )

    // when / then
    expect(mapped.permission["mcp.use"]).toBe("ask")
    expect(mapped.permission["skill.use"]).toBe("deny")
    expect(mapped.permission["plugin.use"]).toBe("allow")
    expect(mapped.tools).toEqual({ "mcp.use": true, "skill.use": false, "plugin.use": true })
  })

  it("#given ask and deny effects #when mapped #then ask keeps the tool listed while deny disables it", () => {
    // given
    const mapped = permissionRulesToV1(rules(["shell", "*", "ask"], ["webfetch", "*", "deny"]))

    // when / then
    expect(mapped.tools["bash"]).toBe(true)
    expect(mapped.permission["bash"]).toBe("ask")
    expect(mapped.tools["webfetch"]).toBe(false)
    expect(mapped.permission["webfetch"]).toBe("deny")
  })

  it("#given a scoped rule #when mapped #then the permission becomes a scope map and no tools entry is set", () => {
    // given
    const mapped = permissionRulesToV1(rules(["shell", "git push*", "deny"]))

    // when / then
    expect(mapped.permission["bash"]).toEqual({ "git push*": "deny" })
    expect(mapped.tools).toEqual({})
  })

  it("#given a flat rule and a scoped rule for one key #when mapped #then the flat effect joins the scope map as the * scope", () => {
    // given
    const mapped = permissionRulesToV1(rules(["edit", "*", "deny"], ["edit", "/tmp/proj/*", "allow"]))

    // when / then
    expect(mapped.permission["write"]).toEqual({ "*": "deny", "/tmp/proj/*": "allow" })
    expect(mapped.permission["patch"]).toEqual({ "*": "deny", "/tmp/proj/*": "allow" })
    expect(mapped.tools).toEqual({ write: false, patch: false })
  })

  it("#given two rules for the same resource #when mapped #then the first effect wins", () => {
    // given
    const mapped = permissionRulesToV1(rules(["shell", "*", "allow"], ["shell", "*", "deny"]))

    // when / then
    expect(mapped.permission["bash"]).toBe("allow")
    expect(mapped.tools["bash"]).toBe(true)
  })

  it("#given actions without a V1 counterpart #when mapped #then they are listed unmapped and reported once each", () => {
    // given
    const reported: string[] = []
    const mapped = permissionRulesToV1(
      rules(["read", "*", "ask"], ["browser", "*", "deny"], ["read", "*.env", "ask"], ["*", "*", "allow"]),
      (action) => reported.push(action),
    )

    // when / then
    expect(mapped.unmapped).toEqual(["read", "browser", "*"])
    expect(reported).toEqual(["read", "browser", "*"])
    expect(mapped.permission).toEqual({})
    expect(mapped.tools).toEqual({})
  })

  it("#given the V1-named actions #when mapped #then webfetch and external_directory keep their V1 permission keys", () => {
    // given
    const mapped = permissionRulesToV1(rules(["webfetch", "*", "allow"], ["external_directory", "*", "ask"]))

    // when / then
    expect(mapped.permission["webfetch"]).toBe("allow")
    expect(mapped.permission["external_directory"]).toBe("ask")
  })
})
