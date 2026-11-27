import { describe, expect, test } from "bun:test"

import type { Hooks } from "@opencode-ai/plugin"

import { createFakeV2Context } from "../parity/fake-v2-context"
import type { FakeSessionPromptEvent } from "../parity/fake-v2-session-store"
import type { V2EngineHooks } from "../runtime/start-v2-runtime"
import type { V2Runtime } from "../runtime/stop-v2-runtime"
import { consumeSessionModelOverride, resetSessionModelOverridesForTesting } from "./model-override-store"
import { registerPromptHookAdapter } from "./adapt-prompt-hook"

// Harness: a fake OpenCode 2 ctx plus a stub engine whose chat.message and
// command.execute.before members record their calls and apply caller-chosen
// mutations, mirroring how the real V1 handlers rewrite the prompt text and
// the message model.

type RecordedCommand = { readonly command: string; readonly sessionID: string; readonly arguments: string }

type RecordedChatMessage = {
  readonly sessionID: string
  readonly agent?: string
  readonly model?: { readonly providerID: string; readonly modelID: string }
  readonly text: string
  readonly messageModel: { readonly providerID: string; readonly modelID: string }
}

type StubEngineScript = {
  readonly commandText?: string
  readonly commandThrow?: string
  readonly chatMessageText?: string
  readonly chatMessageModel?: { readonly providerID: string; readonly modelID: string }
}

type ChatMessageParts = Parameters<NonNullable<Hooks["chat.message"]>>[1]["parts"]

function isTextPart(part: ChatMessageParts[number]): part is Extract<ChatMessageParts[number], { type: "text" }> {
  return part.type === "text"
}

function textOfParts(parts: ChatMessageParts): string {
  return parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n")
}

function createHarness(script: StubEngineScript = {}): {
  readonly ctx: ReturnType<typeof createFakeV2Context>
  readonly runtime: V2Runtime
  readonly commands: RecordedCommand[]
  readonly messages: RecordedChatMessage[]
  readonly firePrompt: (event: FakeSessionPromptEvent) => Promise<FakeSessionPromptEvent>
} {
  const ctx = createFakeV2Context()
  const commands: RecordedCommand[] = []
  const messages: RecordedChatMessage[] = []
  const engine: V2EngineHooks = {
    "command.execute.before": async (input, output) => {
      commands.push({ command: input.command, sessionID: input.sessionID, arguments: input.arguments })
      if (script.commandThrow !== undefined) throw new Error(script.commandThrow)
      if (script.commandText !== undefined)
        output.parts.push({
          id: "cmd_0",
          sessionID: input.sessionID,
          messageID: "msg_1",
          type: "text",
          text: script.commandText,
        })
    },
    "chat.message": async (input, output) => {
      messages.push({
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        text: textOfParts(output.parts),
        messageModel: output.message.model,
      })
      if (script.chatMessageModel !== undefined) output.message.model = script.chatMessageModel
      if (script.chatMessageText !== undefined) {
        for (const part of output.parts) {
          if (part.type === "text") part.text = script.chatMessageText
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
  const firePrompt = async (event: FakeSessionPromptEvent): Promise<FakeSessionPromptEvent> =>
    ctx.__fire("session", "prompt", event)
  return { ctx, runtime, commands, messages, firePrompt }
}

function promptEvent(input: {
  readonly sessionID: string
  readonly text: string
  readonly agents?: ReadonlyArray<{ readonly name: string }>
  readonly messageID?: string
}): FakeSessionPromptEvent {
  return {
    sessionID: input.sessionID,
    messageID: input.messageID ?? "msg_1",
    prompt: { text: input.text, agents: input.agents },
    delivery: "steer",
  }
}

const SESSION = "ses_prompt_hook"

describe("adapt-prompt-hook #given the registered prompt adapter", () => {
  test("#when the chat.message handler replaces the text part #then the mutation lands in event.prompt.text", async () => {
    resetSessionModelOverridesForTesting()
    const harness = createHarness({ chatMessageText: "hello rewritten by the engine" })
    await harness.ctx.session.create({ id: SESSION })
    registerPromptHookAdapter({ ctx: harness.ctx, runtime: harness.runtime })
    const fired = await harness.firePrompt(promptEvent({ sessionID: SESSION, text: "hello" }))
    expect(fired.prompt.text).toBe("hello rewritten by the engine")
    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]?.text).toBe("hello")
  })

  test("#when the prompt is /ulw-execute with a plan argument #then the command handler receives the parsed arguments", async () => {
    resetSessionModelOverridesForTesting()
    const harness = createHarness()
    await harness.ctx.session.create({ id: SESSION })
    registerPromptHookAdapter({ ctx: harness.ctx, runtime: harness.runtime })
    await harness.firePrompt(promptEvent({ sessionID: SESSION, text: "/ulw-execute wave-two-plan" }))
    expect(harness.commands).toEqual([{ command: "ulw-execute", sessionID: SESSION, arguments: "wave-two-plan" }])
    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]?.text).toBe("/ulw-execute wave-two-plan")
  })

  test("#when the command handler produces text #then event.prompt.text becomes the produced text and chat.message sees it", async () => {
    resetSessionModelOverridesForTesting()
    const harness = createHarness({ commandText: "generated work session context" })
    await harness.ctx.session.create({ id: SESSION })
    registerPromptHookAdapter({ ctx: harness.ctx, runtime: harness.runtime })
    const fired = await harness.firePrompt(promptEvent({ sessionID: SESSION, text: "/goal ship the docs" }))
    expect(fired.prompt.text).toBe("generated work session context")
    expect(harness.messages[0]?.text).toBe("generated work session context")
  })

  test("#when the command handler throws #then the prompt hook rejects with that message and chat.message never runs", async () => {
    resetSessionModelOverridesForTesting()
    const harness = createHarness({ commandThrow: "unknown plan: no-such-plan" })
    await harness.ctx.session.create({ id: SESSION })
    registerPromptHookAdapter({ ctx: harness.ctx, runtime: harness.runtime })
    await expect(
      harness.firePrompt(promptEvent({ sessionID: SESSION, text: "/ulw-execute no-such-plan" })),
    ).rejects.toThrow("unknown plan: no-such-plan")
    expect(harness.messages).toHaveLength(0)
  })

  test("#when the session carries a model and an agent is selected #then chat.message receives the V1-shaped input", async () => {
    resetSessionModelOverridesForTesting()
    const harness = createHarness()
    await harness.ctx.session.create({ id: SESSION, model: { id: "gpt-6", providerID: "openai" } })
    registerPromptHookAdapter({ ctx: harness.ctx, runtime: harness.runtime })
    await harness.firePrompt(promptEvent({ sessionID: SESSION, text: "plan it", agents: [{ name: "atlas" }] }))
    expect(harness.messages[0]?.agent).toBe("atlas")
    expect(harness.messages[0]?.model).toEqual({ providerID: "openai", modelID: "gpt-6" })
    expect(harness.messages[0]?.messageModel).toEqual({ providerID: "openai", modelID: "gpt-6" })
  })

  test("#when the chat.message handler requests a different model #then the override is collected for the resolve adapter", async () => {
    resetSessionModelOverridesForTesting()
    const harness = createHarness({ chatMessageModel: { providerID: "openai", modelID: "gpt-6-ultrawork" } })
    await harness.ctx.session.create({ id: SESSION, model: { id: "gpt-6", providerID: "openai" } })
    registerPromptHookAdapter({ ctx: harness.ctx, runtime: harness.runtime })
    await harness.firePrompt(promptEvent({ sessionID: SESSION, text: "ultrawork this" }))
    expect(consumeSessionModelOverride(SESSION)).toEqual({ providerID: "openai", modelID: "gpt-6-ultrawork" })
    expect(consumeSessionModelOverride(SESSION)).toBeUndefined()
  })

  test("#when the prompt is not an intercepted command #then no command handler call happens", async () => {
    resetSessionModelOverridesForTesting()
    const harness = createHarness()
    await harness.ctx.session.create({ id: SESSION })
    registerPromptHookAdapter({ ctx: harness.ctx, runtime: harness.runtime })
    await harness.firePrompt(promptEvent({ sessionID: SESSION, text: "/build something" }))
    expect(harness.commands).toHaveLength(0)
    expect(harness.messages).toHaveLength(1)
  })

  test("#when the prompt is admitted through ctx.session.prompt #then the veto still propagates to the caller", async () => {
    resetSessionModelOverridesForTesting()
    const harness = createHarness({ commandThrow: "veto from the engine" })
    await harness.ctx.session.create({ id: SESSION })
    registerPromptHookAdapter({ ctx: harness.ctx, runtime: harness.runtime })
    await expect(harness.ctx.session.prompt({ sessionID: SESSION, text: "/ulw-execute boom" })).rejects.toThrow(
      "veto from the engine",
    )
  })
})
