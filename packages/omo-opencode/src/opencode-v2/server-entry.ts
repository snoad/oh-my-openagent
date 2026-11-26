import * as Plugin from "@opencode/plugin/promise/plugin"

import { startV2Runtime, type V2RuntimePluginContext } from "./runtime/start-v2-runtime"
import { stopV2Runtime } from "./runtime/stop-v2-runtime"
import { parseHostVersion, type HostVersionInput } from "./version-guard"

type SetupContext = V2RuntimePluginContext & {
  readonly app?: HostVersionInput
}

// OpenCode 2 entry point. setup classifies the host version (task 8), then
// starts the real V1 engine through startV2Runtime: the task-12 client shim
// over this ctx, the D-9 dependency overrides and the refcounted process-wide
// state. Console output of the server process is what the host writes into
// the sandbox serve log, so the markers go through console. The returned
// cleanup stops the runtime. The V1 `server` export beside it keeps running
// the full plugin on OpenCode 1.x.
export const opencodeV2Server = Plugin.define({
  id: "oh-my-openagent",
  setup: async (context: SetupContext) => {
    const guard = parseHostVersion(context.app ?? {})
    if (!guard.ok) {
      console.log(`[opencode-v2] host unsupported ${guard.reason} ${guard.found}`)
      return undefined
    }
    console.log(`[opencode-v2] host supported ${guard.major}.${guard.minor}.${guard.patch}`)
    const runtime = await startV2Runtime(context)
    console.log("[opencode-v2] engine started")
    return () => stopV2Runtime(runtime)
  },
})
