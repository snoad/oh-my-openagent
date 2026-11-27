// V1 command entry -> OpenCode 2 command definition codec (task 27 of the
// opencode-v2-compat plan). The pinned 2.4.1 CommandEditor is add-only and
// its CommandDefinition carries {name, description?, execute(invocation)};
// the definition type derives from the pinned plugin surface through
// import type, and the built item is validated before it reaches the host.
// Execute behavior mirrors V1: a command V1 intercepts in
// plugin/command-execute-before.ts (the names the task-16 prompt-hook
// interception lists) funnels the user's own "/name arguments" text back
// through the host admission (admitUserPrompt) so the prompt hook sees the
// slash name; every other plan command is a template command and execute
// submits the $ARGUMENTS-expanded template exactly as the V1 host expanded
// and submitted it. The V1 per-command model field has no SessionPromptInput
// counterpart and is not carried.

import type { SessionInboxUser, SessionPromptInput } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"

import { admitUserPrompt } from "../client/prompt-raw"
import { PLUGIN_COMMAND_INTERCEPTION_NAMES } from "../hooks/command-interception"
import type { PlanCommandConfig } from "./registration-plan"

type CommandTransformCallback = Parameters<Plugin.Context["command"]["transform"]>[0]
type SdkCommandEditor = Parameters<CommandTransformCallback>[0]
type SdkCommandDefinition = Parameters<SdkCommandEditor["add"]>[0]

export type CommandInvocation = Parameters<SdkCommandDefinition["execute"]>[0]
export type CommandExecute = SdkCommandDefinition["execute"]

export type CommandAdmissionContext = {
  readonly session: {
    readonly prompt: (input: SessionPromptInput) => Promise<SessionInboxUser>
  }
}

export type V2CommandDefinition = {
  readonly name: string
  readonly description?: string
  readonly execute: CommandExecute
}

const INTERCEPTED_NAMES: ReadonlySet<string> = new Set<string>(PLUGIN_COMMAND_INTERCEPTION_NAMES)

const COMMAND_TEXT_PATTERN = /^\/(\S+)(?:\s+([\s\S]*))?$/

export function isInterceptedCommand(name: string): boolean {
  return INTERCEPTED_NAMES.has(name.toLowerCase())
}

// The arguments are the text after the slash name when the submission still
// carries it; a host that stripped the name leaves the remainder as the whole
// prompt text.
export function argumentsOfInvocation(name: string, invocation: CommandInvocation): string {
  const submitted = invocation.prompt.text
  const match = COMMAND_TEXT_PATTERN.exec(submitted)
  if (match !== null && (match[1] ?? "").toLowerCase() === name.toLowerCase()) return (match[2] ?? "").trim()
  return submitted.trim()
}

function slashTextOf(name: string, args: string): string {
  return args.length > 0 ? `/${name} ${args}` : `/${name}`
}

export function expandedTemplateOf(template: string, args: string): string {
  return template.replaceAll("$ARGUMENTS", args)
}

// One admission per session and command at a time: when the host itself
// dispatches the relayed text back into execute, the second call is the same
// submission and must not relay again (the interception of the first relay is
// already running).
async function relaySubmission(ctx: CommandAdmissionContext, key: string, input: SessionPromptInput): Promise<void> {
  if (relayingSubmissions.has(key)) return
  relayingSubmissions.add(key)
  try {
    await admitUserPrompt(ctx, input)
  } finally {
    relayingSubmissions.delete(key)
  }
}

const relayingSubmissions = new Set<string>()

function executeOf(ctx: CommandAdmissionContext, name: string, entry: PlanCommandConfig): CommandExecute {
  const intercepted = isInterceptedCommand(name)
  return async (invocation: CommandInvocation) => {
    const args = argumentsOfInvocation(name, invocation)
    const key = `${invocation.sessionID}\u0000${name.toLowerCase()}`
    if (intercepted) {
      await relaySubmission(ctx, key, {
        sessionID: invocation.sessionID,
        text: slashTextOf(name, args),
        metadata: { omo: { command: name } },
      })
      return
    }
    const template = typeof entry.template === "string" ? entry.template : ""
    await relaySubmission(ctx, key, {
      sessionID: invocation.sessionID,
      text: expandedTemplateOf(template, args),
      ...(typeof entry.agent === "string" && entry.agent !== "" ? { agents: [{ name: entry.agent }] } : {}),
    })
  }
}

export function isValidCommandDefinition(definition: V2CommandDefinition): boolean {
  return definition.name.length > 0 && typeof definition.execute === "function"
}

export async function toV2CommandDefinition(
  ctx: CommandAdmissionContext,
  name: string,
  entry: PlanCommandConfig,
): Promise<V2CommandDefinition> {
  return {
    name,
    ...(typeof entry.description === "string" && entry.description !== "" ? { description: entry.description } : {}),
    execute: executeOf(ctx, name, entry),
  }
}
