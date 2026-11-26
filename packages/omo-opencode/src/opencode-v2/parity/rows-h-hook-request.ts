import { expect } from "./bun-test-shim"

import type { SessionMessageInfo } from "@opencode/client"
import { registerRequestHookAdapters, type V2ModelRequestEvent } from "../hooks/adapt-request-hooks"
import type { V2Runtime } from "../runtime/stop-v2-runtime"
import { createFakeV2Context } from "./fake-v2-context"
import { defineGroup, type ParityRow, type ParityRowGroupItem } from "./rows"

// Wave-2 H-HOOK rows owned by plan task 18: the chat.headers adaptation to
// the OpenCode 2 model.request hook. The row drives the real client-shim
// path over the fake ctx with a recording stub engine and asserts the V1
// input shape plus the header merge into the mutable event headers.

const SESSION = "ses_h_hook_headers"

function row(suffix: string, title: string, check: () => void | Promise<void>): ParityRowGroupItem {
  return { suffix, title, kind: "hermetic", is: ["IS-4"], wave: 2, status: "checked", check }
}

async function checkRequestHeaders(): Promise<void> {
  const ctx = createFakeV2Context()
  await ctx.session.create({ id: SESSION })
  const entry: SessionMessageInfo = {
    id: "msg_user",
    type: "user",
    time: { created: 10 },
    text: "carry the internal marker",
    files: [],
  }
  const record = ctx.__sessions.get(SESSION)
  if (record === undefined) throw new Error(`unknown session ${SESSION}`)
  ;(record.context as SessionMessageInfo[]).push(entry)
  const calls: Array<{ sessionID: string; providerID?: string; messageID?: string; role?: string }> = []
  const engine: V2Runtime["engine"] = {
    "chat.headers": async (input, output) => {
      calls.push({
        sessionID: input.sessionID,
        providerID: (input.provider as { id?: string }).id,
        messageID: input.message.id,
        role: input.message.role,
      })
      output.headers["x-initiator"] = "agent"
    },
  }
  registerRequestHookAdapters({
    ctx,
    runtime: {
      directory: "/tmp/fake-v2",
      engine,
      tracker: { releasedDeps: new Set(), sharedHandles: [] },
      abort: new AbortController(),
      stopped: false,
      stop: async () => {},
    },
  })
  const event: V2ModelRequestEvent = {
    sessionID: SESSION,
    kind: "primary",
    model: { id: "claude-x", providerID: "github-copilot" },
    headers: {},
  }
  const fired = await ctx.__fire("session", "model.request", event)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.sessionID).toBe(SESSION)
  expect(calls[0]?.providerID).toBe("github-copilot")
  expect(calls[0]?.messageID).toBe("msg_user")
  expect(calls[0]?.role).toBe("user")
  expect(fired.headers["x-initiator"]).toBe("agent")
}

export const hHookRequestRows: ParityRow[] = defineGroup("H-HOOK", [
  row(
    "REQUEST-HEADERS",
    "chat.headers adaptation resolves the latest user message through the client shim, calls the V1 handler and merges the headers into the mutable model.request event",
    checkRequestHeaders,
  ),
])
