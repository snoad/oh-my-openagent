import * as Plugin from "@opencode/plugin/tui/plugin"

import { buildUnsupportedHostNotice, OPENCODE_V2_NOTICE_DURATION_MS } from "./startup-notice"
import { parseHostVersion, type HostVersionInput } from "./version-guard"

type NoticeToast = {
  readonly ui: {
    readonly toast: {
      readonly show: (options: {
        readonly title: string
        readonly message: string
        readonly variant: "warning"
        readonly duration: number
      }) => void
    }
  }
}

type NoticeContext = NoticeToast & {
  readonly app?: HostVersionInput
}

export function showOpenCodeV2Notice(context: NoticeContext): void {
  // The floor toast only fires for a host that reports a version the guard
  // rejects; supported hosts get no toast at all.
  const version = context.app?.version
  if (typeof version !== "string" || version.length === 0) return
  const guard = parseHostVersion(context.app ?? {})
  if (guard.ok) return
  const notice = buildUnsupportedHostNotice(guard.found)
  context.ui.toast.show({
    title: notice.title,
    message: notice.message,
    variant: "warning",
    duration: OPENCODE_V2_NOTICE_DURATION_MS,
  })
}

export const opencodeV2Tui = Plugin.define({
  id: "oh-my-openagent:tui",
  setup: (context) => {
    showOpenCodeV2Notice(context)
  },
})
