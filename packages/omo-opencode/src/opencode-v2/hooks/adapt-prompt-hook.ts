import type { Hooks } from "@opencode-ai/plugin"

import { matchPluginCommand } from "./command-interception"
import { recordSessionModelOverride, type V1SessionModelRef } from "./model-override-store"
import { markHook } from "../runtime/hook-markers"
import type { V2RuntimePluginContext } from "../runtime/start-v2-runtime"
import type { V2Runtime } from "../runtime/stop-v2-runtime"

// Prompt hook adapter (plan task 16 of opencode-v2-compat). OpenCode 2 runs
// the session "prompt" hook once at admission, before the prompt is durably
// accepted; V1 had no equivalent (commands arrived through
// command.execute.before and every message through chat.message). This
// adapter replays both V1 handlers against the mutable prompt event: a
// plugin command match first runs engine["command.execute.before"] (a throw
// propagates and vetoes the admission) and replaces the prompt text with the
// text the handler produced, then engine["chat.message"] runs with the
// selected agent and the session model and its text mutations are written
// back to event.prompt.text. A model override requested by the chat.message
// handler (output.message.model) is recorded for the resolve adapter.

type ChatMessageHandler = NonNullable<Hooks["chat.message"]>
type ChatMessageInput = Parameters<ChatMessageHandler>[0]
type ChatMessageOutput = Parameters<ChatMessageHandler>[1]
type CommandOutput = Parameters<NonNullable<Hooks["command.execute.before"]>>[1]

// The shim context slice has no hook member, so the registration crosses
// through this structural slice (same pattern as V2EventSubscriptionContext
// in the events adapter). The hook payload is mirrored locally: the SDK
// SessionPrompt carries effect-branded ids that cannot be constructed
// hermetically.
export type V2SessionHookHostContext = V2RuntimePluginContext & {
  readonly session: {
    readonly hook: <TEvent extends object>(
      name: string,
      callback: (event: TEvent) => void | Promise<void>,
    ) => Promise<unknown>
  }
}

export type V2PromptHookEvent = {
  readonly sessionID: string
  readonly messageID: string
  readonly prompt: {
    text: string
    files?: ReadonlyArray<unknown>
    agents?: ReadonlyArray<{ readonly name: string }>
    skills?: ReadonlyArray<unknown>
  }
  readonly metadata?: Record<string, unknown>
  readonly delivery?: "steer" | "queue"
}

export function sessionHookTarget(ctx: V2RuntimePluginContext): V2SessionHookHostContext {
  return ctx as V2SessionHookHostContext
}

function isInternalAdmission(metadata: V2PromptHookEvent["metadata"]): boolean {
  const omo: unknown = metadata?.["omo"]
  if (typeof omo !== "object" || omo === null || Array.isArray(omo)) return false
  const record = omo as Record<string, unknown>
  return record["internal"] === true
}

function isTextPart(
  part: ChatMessageOutput["parts"][number],
): part is Extract<ChatMessageOutput["parts"][number], { type: "text" }> {
  return part.type === "text"
}

// The ulw-execute hook joins prompt text parts with "\n" when it reads a
// message; the write-back uses the same convention.
function textOfParts(parts: ChatMessageOutput["parts"]): string {
  return parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n")
}

async function sessionModelOf(ctx: V2RuntimePluginContext, sessionID: string): Promise<V1SessionModelRef | undefined> {
  const info = await ctx.session.get({ sessionID })
  const model = info.model
  if (model === undefined) return undefined
  return { providerID: model.providerID, modelID: model.id }
}

async function runPromptPipeline(
  ctx: V2RuntimePluginContext,
  runtime: V2Runtime,
  event: V2PromptHookEvent,
): Promise<void> {
  const internal = isInternalAdmission(event.metadata)
  const sessionID = event.sessionID

  if (!internal) {
    const match = matchPluginCommand(event.prompt.text)
    if (match !== null) {
      const commandOutput: CommandOutput = { parts: [] }
      await runtime.engine["command.execute.before"]?.(
        { command: match.command, sessionID, arguments: match.arguments },
        commandOutput,
      )
      markHook("command.execute.before", sessionID)
      const produced = textOfParts(commandOutput.parts)
      if (produced.length > 0) event.prompt.text = produced
    }
  }

  const agentName = event.prompt.agents?.[0]?.name ?? ""
  const sessionModel = await sessionModelOf(ctx, sessionID)
  const seededModel: ChatMessageOutput["message"]["model"] = {
    providerID: sessionModel?.providerID ?? "",
    modelID: sessionModel?.modelID ?? "",
  }
  // V1's chat.message handler early-returns on synthetic/internal-only
  // parts; stamping shim-internal admissions synthetic keeps that gate
  // working on OpenCode 2.
  const output: ChatMessageOutput = {
    message: {
      id: event.messageID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: agentName,
      model: seededModel,
    },
    parts: [
      {
        id: `${event.messageID}:0`,
        sessionID,
        messageID: event.messageID,
        type: "text",
        text: event.prompt.text,
        synthetic: internal || undefined,
      },
    ],
  }
  const chatMessageInput: ChatMessageInput = {
    sessionID,
    agent: agentName.length > 0 ? agentName : undefined,
    model: sessionModel,
  }
  await runtime.engine["chat.message"]?.(chatMessageInput, output)
  markHook("chat.message", sessionID)

  const rewritten = textOfParts(output.parts)
  if (rewritten.length > 0 && rewritten !== event.prompt.text) event.prompt.text = rewritten

  const requestedModel = output.message.model
  if (requestedModel.providerID !== seededModel.providerID || requestedModel.modelID !== seededModel.modelID) {
    recordSessionModelOverride(sessionID, requestedModel)
  }
}

export async function registerPromptHookAdapter(input: {
  readonly ctx: V2RuntimePluginContext
  readonly runtime: V2Runtime
}): Promise<void> {
  const hookCtx = sessionHookTarget(input.ctx)
  await hookCtx.session.hook("prompt", (event: V2PromptHookEvent) => runPromptPipeline(input.ctx, input.runtime, event))
}
