import { describe, expect, test } from "bun:test"

import { matchPluginCommand, PLUGIN_COMMAND_INTERCEPTION_NAMES } from "./command-interception"

// The interception inventory mirrors the commands V1 dispatches on inside
// plugin/command-execute-before.ts (omo-mcp-env-grant, stop-continuation,
// goal, ulw-execute); the ulwExecute fan-out shares the ulw-execute name.

describe("command-interception #given the plugin command inventory", () => {
  test("#then it is exactly the V1 command.execute.before dispatch set", () => {
    expect([...PLUGIN_COMMAND_INTERCEPTION_NAMES].sort()).toEqual([
      "goal",
      "omo-mcp-env-grant",
      "stop-continuation",
      "ulw-execute",
    ])
  })
})

describe("command-interception #given text that starts with a plugin command", () => {
  test("#when the text is the bare name #then the arguments are empty", () => {
    expect(matchPluginCommand("/goal")).toEqual({ command: "goal", arguments: "" })
    expect(matchPluginCommand("/stop-continuation")).toEqual({ command: "stop-continuation", arguments: "" })
  })

  test("#when the text carries arguments #then everything after the name is captured", () => {
    expect(matchPluginCommand("/ulw-execute my-plan")).toEqual({ command: "ulw-execute", arguments: "my-plan" })
    expect(matchPluginCommand("/ulw-execute my-plan --make-pr")).toEqual({
      command: "ulw-execute",
      arguments: "my-plan --make-pr",
    })
  })

  test("#when the arguments span multiple whitespace runs #then the raw remainder is kept trimmed", () => {
    expect(matchPluginCommand("/goal   ship the docs  ")).toEqual({ command: "goal", arguments: "ship the docs" })
    expect(matchPluginCommand("/omo-mcp-env-grant  server-a NAME_A NAME_B")).toEqual({
      command: "omo-mcp-env-grant",
      arguments: "server-a NAME_A NAME_B",
    })
  })

  test("#when the name casing differs #then the command still matches lowercased", () => {
    expect(matchPluginCommand("/ULW-Execute plan")).toEqual({ command: "ulw-execute", arguments: "plan" })
  })
})

describe("command-interception #given text that is not an intercepted command", () => {
  test("#when the text does not start with a slash #then there is no match", () => {
    expect(matchPluginCommand("plan the ultrawork run")).toBeNull()
    expect(matchPluginCommand(" /goal")).toBeNull()
    expect(matchPluginCommand("")).toBeNull()
  })

  test("#when the name is unknown to the plugin #then there is no match", () => {
    expect(matchPluginCommand("/build something")).toBeNull()
    expect(matchPluginCommand("/goals")).toBeNull()
    expect(matchPluginCommand("/ulw-executor x")).toBeNull()
  })

  test("#when a longer name shares a prefix with an inventory name #then the exact name wins and the longer one does not", () => {
    expect(matchPluginCommand("/goal-extra")).toBeNull()
    expect(matchPluginCommand("/goal set")).toEqual({ command: "goal", arguments: "set" })
  })
})
