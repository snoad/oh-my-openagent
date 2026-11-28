import { describe, expect, it } from "bun:test"

import { createFakeV2Context } from "../parity/fake-v2-context"
import { mapAgentToV1Config } from "./agent-mapping"
import { assignAgentItem } from "./agent-v1-to-v2"
import type { SnapshotAgentRecord } from "./snapshot-inputs"

const fixtureAgents = createFakeV2Context().agent

async function fixtureAgentByName(name: string): Promise<SnapshotAgentRecord> {
  const response = await fixtureAgents.list()
  const agent = response.data.find((entry) => entry.name === name)
  if (agent === undefined) throw new Error(`fixture agent ${name} missing`)
  return agent
}

describe("agent mapping to V1 AgentConfig", () => {
  it("#given a V2 agent with system, model and description #when mapped #then system becomes prompt and the model joins provider/model", () => {
    // given
    const agent: SnapshotAgentRecord = {
      id: "a1",
      name: "worker",
      mode: "subagent",
      description: "does work",
      system: "You are a worker.",
      model: { id: "claude-x", providerID: "anthropic" },
      permissions: [],
    }

    // when
    const config = mapAgentToV1Config(agent)

    // then
    expect(config.prompt).toBe("You are a worker.")
    expect(config.model).toBe("anthropic/claude-x")
    expect(config.description).toBe("does work")
    expect(config.mode).toBe("subagent")
    expect(config.tools).toEqual({})
    expect(config.permission).toEqual({})
  })

  it("#given the fixture Explore agent #when mapped #then its shell and subagent rules land in its own tools and permission maps", async () => {
    // given
    const agent = await fixtureAgentByName("Explore")

    // when
    const config = mapAgentToV1Config(agent)

    // then
    expect(config.tools["bash"]).toBe(true)
    expect(config.tools["task"]).toBe(false)
    expect(config.permission["bash"]).toBe("allow")
    expect(config.permission["task"]).toBe("deny")
    expect(config.permission["external_directory"]).toBe("allow")
  })

  it("#given the fixture Plan agent #when mapped #then the scoped edit rule lands as a scope map on write and patch", async () => {
    // given
    const agent = await fixtureAgentByName("Plan")

    // when
    const config = mapAgentToV1Config(agent)

    // then
    expect(config.tools["write"]).toBe(false)
    expect(config.tools["patch"]).toBe(false)
    const write = config.permission["write"]
    expect(write).toEqual({ "*": "deny", "/tmp/oqa-v2-sandbox.5Lvyln/home/.opencode/plan/*": "allow" })
    expect(config.permission["patch"]).toEqual(write)
  })

  it("#given a hidden fixture agent #when mapped #then hidden survives for the V1 demotion", async () => {
    // given
    const agent = await fixtureAgentByName("Compaction")

    // when
    const config = mapAgentToV1Config(agent)

    // then
    expect(config["hidden"]).toBe(true)
  })

  it("#given an agent with only unmapped actions #when mapped #then the tools and permission maps stay empty", () => {
    // given
    const agent: SnapshotAgentRecord = {
      id: "a2",
      name: "reader",
      mode: "all",
      permissions: [
        { action: "read", resource: "*", effect: "ask" },
        { action: "browser", resource: "*", effect: "deny" },
      ],
    }

    // when
    const config = mapAgentToV1Config(agent)

    // then
    expect(config.tools).toEqual({})
    expect(config.permission).toEqual({})
  })
})

describe("assignAgentItem name_only replay", () => {
  it("#given a name_only entry #when the item is replayed #then the name lands and the host system bytes stay untouched", () => {
    // given
    const item = {
      id: "compaction",
      name: "Compaction",
      mode: "primary" as const,
      hidden: true,
      system: "the host's own compaction prompt",
    }

    // when
    assignAgentItem(item, "compaction", { name_only: true, name: "compaction" })

    // then
    expect(item.name).toBe("compaction")
    expect(item.system).toBe("the host's own compaction prompt")
    expect(item.mode).toBe("primary")
    expect(item.hidden).toBe(true)
  })
})
