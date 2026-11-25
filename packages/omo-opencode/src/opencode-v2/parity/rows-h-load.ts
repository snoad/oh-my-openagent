import { expect } from "bun:test"

import pluginModule from "../../index"
import { defineGroup, type ParityRow } from "./rows"

// Wave-0 export shape facts, asserted through the real plugin entry. The SDK
// pin and Plugin.define identity live in sdk-surface.test.ts (task 1), and the
// version guard matrix rows below are flipped by task 8.
function checkServerExportKeys(): void {
  // given
  const definition = pluginModule

  // when
  const keys = Object.keys(definition).sort()

  // then
  expect(keys).toEqual(["id", "server", "setup"])
}

function checkServerExportId(): void {
  // given
  const definition = pluginModule

  // when
  const server = definition.server
  const setup = definition.setup

  // then
  expect(definition.id).toBe("oh-my-openagent")
  expect(typeof server).toBe("function")
  expect(typeof setup).toBe("function")
}

export const hLoadRows: ParityRow[] = defineGroup("H-LOAD", [
  {
    suffix: "EXPORT-KEYS",
    title: "server entry default export exposes exactly the id, server and setup keys",
    kind: "hermetic",
    is: ["IS-1"],
    wave: 0,
    status: "checked",
    check: checkServerExportKeys,
  },
  {
    suffix: "EXPORT-ID",
    title: "server entry default export id is oh-my-openagent with callable server and setup",
    kind: "hermetic",
    is: ["IS-1"],
    wave: 0,
    status: "checked",
    check: checkServerExportId,
  },
  {
    suffix: "GUARD-SUPPORTED-2-4-1",
    title: "the host version guard admits 2.4.1",
    kind: "hermetic",
    is: ["IS-15"],
    wave: 1,
  },
  {
    suffix: "GUARD-SUPPORTED-2-4-0",
    title: "the host version guard admits 2.4.0",
    kind: "hermetic",
    is: ["IS-15"],
    wave: 1,
  },
  {
    suffix: "GUARD-BELOW-FLOOR-2-3-9",
    title: "the host version guard rejects 2.3.9 as below the 2.4 floor",
    kind: "hermetic",
    is: ["IS-15"],
    wave: 1,
  },
  {
    suffix: "GUARD-ABOVE-VERIFIED-3-0-0",
    title: "the host version guard rejects 3.0.0 as above the verified major",
    kind: "hermetic",
    is: ["IS-15"],
    wave: 1,
  },
  {
    suffix: "GUARD-MALFORMED",
    title: "the host version guard rejects a malformed host version",
    kind: "hermetic",
    is: ["IS-15"],
    wave: 1,
  },
])
