import * as Plugin from "@opencode/plugin/promise/plugin"

import { parseHostVersion, type HostVersionInput } from "./version-guard"

type SetupContext = {
  readonly app?: HostVersionInput
}

// OpenCode 2 entry point. Guard-only for now: setup classifies the host
// version and logs one marker line. The supported-host engine start arrives
// with task 13. The V1 `server` export beside it keeps running the full
// plugin on OpenCode 1.x. Console output of the server process is what the
// host writes into opencode.log, so the markers go through console.
export const opencodeV2Server = Plugin.define({
  id: "oh-my-openagent",
  setup: (context: SetupContext) => {
    const guard = parseHostVersion(context.app ?? {})
    if (!guard.ok) {
      console.log(`[opencode-v2] host unsupported ${guard.reason} ${guard.found}`)
      return undefined
    }
    console.log(`[opencode-v2] host supported ${guard.major}.${guard.minor}.${guard.patch}`)
    return undefined
  },
})
