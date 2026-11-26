import { describe, expect, it } from "bun:test"

import toolsFixture from "../parity/fixtures/host-2.4.1/tools.json"
import {
  V2_CODEMODE_TOOL_NAME_ALIASES,
  V2_TOOL_NAME_CLASSIFICATIONS,
  toV1ToolName,
  toV1ToolNameForCall,
} from "./tool-name-aliases"

// Tool name aliases (plan task 15): toV1ToolName routes the OpenCode 2 tool
// names of the host-2.4.1 fixture to the V1 names the engine's hooks key on
// (shell -> bash so SRC/hooks/bash-file-read-guard.ts logic is reached,
// patch -> edit, subagent -> task), strips the V1 mcp_ prefix convention, and
// passes Code Mode calls through the codemode table (LIM-19).

function fixtureToolIds(): string[] {
  return toolsFixture.tools.map((tool) => tool.id)
}

describe("toV1ToolName", () => {
  it("#given the recorded host fixture #when classifying #then every tool has exactly one classification", () => {
    const expected = [...fixtureToolIds()].sort()
    const classified = V2_TOOL_NAME_CLASSIFICATIONS.map((entry) => entry.v2).sort()
    expect(classified, "every fixture tool must carry a classification").toEqual(expected)
  })

  it("#given the alias entries #when mapping #then the OpenCode 2 shell tool reaches the V1 bash guards", () => {
    expect(toV1ToolName("shell")).toBe("bash")
    expect(toV1ToolName("patch")).toBe("edit")
    expect(toV1ToolName("subagent")).toBe("task")
  })

  it("#given names identical in both hosts #when mapping #then the name passes through unchanged", () => {
    for (const name of ["glob", "grep", "question", "read", "skill", "webfetch"]) {
      expect(toV1ToolName(name)).toBe(name)
    }
  })

  it("#given tools without a V1 equivalent #when mapping #then the name passes through unchanged", () => {
    for (const name of ["execute", "generate_image", "generate_video", "websearch"]) {
      expect(toV1ToolName(name)).toBe(name)
    }
  })

  it("#given an mcp_ prefixed name #when mapping #then the V1 registry convention strips the prefix once, case-insensitively", () => {
    expect(toV1ToolName("mcp_background_output")).toBe("background_output")
    expect(toV1ToolName("MCP_Background_Output")).toBe("Background_Output")
    expect(toV1ToolName("mcp_shell")).toBe("bash")
    expect(toV1ToolName("mcpatch")).toBe("mcpatch")
  })
})

describe("toV1ToolNameForCall", () => {
  it("#given a Code Mode call (LIM-19) #when no codemode entry exists #then the OpenCode 2 name passes unchanged", () => {
    expect(toV1ToolNameForCall("shell", true)).toBe("shell")
    expect(toV1ToolNameForCall("read", true)).toBe("read")
    expect(toV1ToolNameForCall("mcp_background_output", true)).toBe("mcp_background_output")
    expect(Object.keys(V2_CODEMODE_TOOL_NAME_ALIASES)).toEqual([])
  })

  it("#given a regular call #when mapping #then the alias table still applies", () => {
    expect(toV1ToolNameForCall("shell", false)).toBe("bash")
    expect(toV1ToolNameForCall("read", false)).toBe("read")
  })
})
