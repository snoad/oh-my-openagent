import { expect } from "./bun-test-shim"

import type { Hooks } from "@opencode-ai/plugin"

import { createFakeV2Context } from "./fake-v2-context"
import { resetSessionModelOverridesForTesting } from "../hooks/model-override-store"
import { registerModelResolveAdapter, type V2ModelResolveEvent } from "../hooks/adapt-model-resolve"
import { registerPromptHookAdapter } from "../hooks/adapt-prompt-hook"
import type { V2Runtime } from "../runtime/stop-v2-runtime"
import { defineGroup, type ParityRow, type ParityRowGroupItem } from "./rows"

// Wave-2 H-HOOK rows (plan task 16): the OpenCode 2 prompt hook carries the
// V1 chat.message handler and the command interception. Both checks drive
// the registered adapter callbacks over the fake ctx (through __fire, the
// same callback the host invokes at admission) with a stub engine that
// records its calls and applies caller-chosen mutations. The model resolve
// half of the pipeline is exercised inside the chat.message row.

const SESSION = "ses_h_hook"

type ChatMessageParts = Parameters<NonNullable<Hooks["chat.message"]>>[1]["parts"]

function isTextPart(part: ChatMessageParts[number]): part is Extract<ChatMessageParts[number], { type: "text" }> {
  return part.type === "text"
}

async function createHookHarness(script: {
  readonly commandText?: string
  readonly commandThrow?: string
  readonly chatMessageText?: string
  readonly chatMessageModel?: { readonly providerID: string; readonly modelID: string }
}): Promise<{
  readonly ctx: ReturnType<typeof createFakeV2Context>
  readonly commands: Array<{ command: string; sessionID: string; arguments: string }>
  readonly messages: Array<{ sessionID: string; agent?: string; model?: { providerID: string; modelID: string } }>
}> {
  const ctx = createFakeV2Context()
  const commands: Array<{ command: string; sessionID: string; arguments: string }> = []
  const messages: Array<{ sessionID: string; agent?: string; model?: { providerID: string; modelID: string } }> = []
  const engine: Hooks = {
    "command.execute.before": async (input, output) => {
      commands.push({ command: input.command, sessionID: input.sessionID, arguments: input.arguments })
      if (script.commandThrow !== undefined) throw new Error(script.commandThrow)
      if (script.commandText !== undefined) {
        output.parts.push({
          id: "cmd_0",
          sessionID: input.sessionID,
          messageID: "msg_1",
          type: "text",
          text: script.commandText,
        })
      }
    },
    "chat.message": async (input, output) => {
      messages.push({ sessionID: input.sessionID, agent: input.agent, model: input.model })
      if (script.chatMessageModel !== undefined) output.message.model = script.chatMessageModel
      if (script.chatMessageText !== undefined) {
        for (const part of output.parts) {
          if (isTextPart(part)) part.text = script.chatMessageText
        }
      }
    },
  }
  const runtime: V2Runtime = {
    directory: ctx.location.directory,
    engine,
    tracker: { releasedDeps: new Set(), sharedHandles: [] },
    abort: new AbortController(),
    stop: async () => {},
    stopped: false,
  }
  await registerPromptHookAdapter({ ctx, runtime })
  await registerModelResolveAdapter({ ctx, runtime })
  return { ctx, commands, messages }
}

async function checkCommandExecuteBefore(): Promise<void> {
  resetSessionModelOverridesForTesting()
  const harness = await createHookHarness({ commandText: "generated work session context" })
  await harness.ctx.session.create({ id: SESSION })
  const fired = await harness.ctx.__fire("session", "prompt", {
    sessionID: SESSION,
    messageID: "msg_1",
    prompt: { text: "/ulw-execute wave-two-plan" },
    delivery: "steer",
  })
  expect(harness.commands).toEqual([{ command: "ulw-execute", sessionID: SESSION, arguments: "wave-two-plan" }])
  expect(fired.prompt.text).toBe("generated work session context")
  const veto = await createHookHarness({ commandThrow: "unknown plan: no-such-plan" })
  await veto.ctx.session.create({ id: SESSION })
  await expect(
    veto.ctx.__fire("session", "prompt", {
      sessionID: SESSION,
      messageID: "msg_1",
      prompt: { text: "/ulw-execute no-such-plan" },
      delivery: "steer",
    }),
  ).rejects.toThrow("unknown plan: no-such-plan")
  expect(veto.messages).toHaveLength(0)
}

async function checkChatMessage(): Promise<void> {
  resetSessionModelOverridesForTesting()
  const harness = await createHookHarness({
    chatMessageText: "hello rewritten by the engine",
    chatMessageModel: { providerID: "openai", modelID: "gpt-6-ultrawork" },
  })
  await harness.ctx.session.create({ id: SESSION, model: { id: "gpt-6", providerID: "openai" } })
  const fired = await harness.ctx.__fire("session", "prompt", {
    sessionID: SESSION,
    messageID: "msg_1",
    prompt: { text: "hello", agents: [{ name: "atlas" }] },
    delivery: "steer",
  })
  expect(harness.messages).toHaveLength(1)
  expect(harness.messages[0]?.agent).toBe("atlas")
  expect(harness.messages[0]?.model).toEqual({ providerID: "openai", modelID: "gpt-6" })
  expect(fired.prompt.text).toBe("hello rewritten by the engine")
  const resolve: V2ModelResolveEvent = { sessionID: SESSION, model: { id: "gpt-6", providerID: "openai" } }
  await harness.ctx.__fire("session", "experimental.model.resolve", resolve)
  expect(resolve.model.id).toBe("gpt-6-ultrawork")
  expect(resolve.model.providerID).toBe("openai")
}

function row(suffix: string, title: string, check: () => void | Promise<void>): ParityRowGroupItem {
  return { suffix, title, kind: "hermetic", is: ["IS-4", "IS-8"], wave: 2, status: "checked", check }
}

export const hHookPromptRows: ParityRow[] = defineGroup("H-HOOK", [
  row(
    "COMMAND-EXECUTE-BEFORE",
    "the prompt hook intercepts plugin commands with parsed arguments, applies the produced text and propagates a handler throw as a veto",
    checkCommandExecuteBefore,
  ),
  row(
    "CHAT-MESSAGE",
    "the prompt hook seeds chat.message with the selected agent and session model, writes text mutations back and the same-provider model override lands on model resolve",
    checkChatMessage,
  ),
])
