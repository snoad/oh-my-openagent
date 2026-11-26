// In-memory session store behind the fake OpenCode 2 ctx.session (task 9 of
// the opencode-v2-compat plan). Method types are derived from the pinned
// node_modules/@opencode/plugin 2.4.1 declarations through the sanctioned root
// type import: the client-side session shapes are plain (unbranded) in 2.4.1,
// so the fake returns values the SDK itself would return. Only the prompt
// hook payload is a local mirror, because the SDK hook payload carries
// effect-branded ids that cannot be constructed without the schema runtime.

import type { Plugin } from "@opencode/plugin"

import type { FakeHookRegistry, FakeHookOptions, FakeRegistration, FakeScheduler } from "./fake-v2-registry"

type SessionDomain = Plugin.Context["session"]
type SessionCreateInput = Parameters<SessionDomain["create"]>[0]
type SessionInfo = Awaited<ReturnType<SessionDomain["create"]>>
type SessionGetInput = Parameters<SessionDomain["get"]>[0]
type SessionListInput = Parameters<SessionDomain["list"]>[0]
type SessionsResponse = Awaited<ReturnType<SessionDomain["list"]>>
type SessionPromptInput = Parameters<SessionDomain["prompt"]>[0]
type SessionInboxUser = Awaited<ReturnType<SessionDomain["prompt"]>>
type SessionContextInput = Parameters<SessionDomain["context"]>[0]
type SessionMessageInfo = Awaited<ReturnType<SessionDomain["context"]>>[number]
type SessionUpdateInput = Parameters<SessionDomain["update"]>[0]
type SessionInterruptInput = Parameters<SessionDomain["interrupt"]>[0]
type SessionInterruptResponse = Awaited<ReturnType<SessionDomain["interrupt"]>>
type PromptMetadata = SessionPromptInput["metadata"]

// Mirror of the SDK SessionPrompt hook payload with plain ids. prompt keeps
// the admitted text and attachments; metadata is the admission metadata, so
// the omo.internal tag the V2 shim stamps stays observable to hook callbacks.
export type FakeSessionPromptEvent = {
  readonly sessionID: string
  readonly messageID: string
  readonly prompt: Pick<SessionPromptInput, "text" | "files" | "agents" | "skills">
  readonly metadata?: PromptMetadata
  readonly delivery: "steer" | "queue"
}

export type FakeSessionRecord = {
  readonly info: SessionInfo
  busy: boolean
  readonly prompts: SessionInboxUser[]
  readonly context: SessionMessageInfo[]
}

export interface FakeSessionDomain {
  create(input?: SessionCreateInput): Promise<SessionInfo>
  get(input: SessionGetInput): Promise<SessionInfo>
  list(input?: SessionListInput): Promise<SessionsResponse>
  context(input: SessionContextInput): Promise<SessionMessageInfo[]>
  prompt(input: SessionPromptInput): Promise<SessionInboxUser>
  interrupt(input: SessionInterruptInput): Promise<SessionInterruptResponse>
  update(input: SessionUpdateInput): Promise<void>
  hook<TEvent extends object>(
    name: string,
    callback: (input: TEvent) => void | Promise<void>,
    options?: FakeHookOptions,
  ): Promise<FakeRegistration>
}

export type FakeSessionStore = {
  readonly domain: FakeSessionDomain
  readonly sessions: ReadonlyMap<string, FakeSessionRecord>
}

// The V2 shim (plan task 12) stamps metadata.omo.internal = true on every
// admission it makes; the fake uses the same nested path to separate internal
// continuations from real user prompts.
function isInternalAdmission(metadata: PromptMetadata): boolean {
  const omo = metadata?.["omo"]
  return typeof omo === "object" && omo !== null && !Array.isArray(omo) && omo["internal"] === true
}

export function createSessionStore(input: {
  readonly registry: FakeHookRegistry
  readonly scheduler: FakeScheduler
  readonly locationDirectory: string
  readonly projectID: string
  readonly idPrefix?: string
}): FakeSessionStore {
  const { registry, scheduler, locationDirectory, projectID } = input
  const sessions = new Map<string, FakeSessionRecord>()
  let sequence = 0

  const mustRecord = (sessionID: string): FakeSessionRecord => {
    const record = sessions.get(sessionID)
    if (!record) throw new Error(`fake v2: unknown session ${sessionID}`)
    return record
  }

  const touch = (record: FakeSessionRecord): void => {
    record.info.time.updated = scheduler.now()
  }

  const domain: FakeSessionDomain = {
    async create(createInput) {
      sequence += 1
      const id = createInput?.id ?? `ses_${sequence}`
      const info: SessionInfo = {
        id,
        parentID: createInput?.parentID ?? undefined,
        projectID,
        agent: createInput?.agent ?? undefined,
        model: createInput?.model ?? undefined,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: scheduler.now(), updated: scheduler.now() },
        title: createInput?.title ?? undefined,
        metadata: createInput?.metadata ? { ...createInput.metadata } : undefined,
        location: { directory: locationDirectory },
      }
      sessions.set(id, { info, busy: false, prompts: [], context: [] })
      return info
    },

    async get(getInput) {
      return mustRecord(getInput.sessionID).info
    },

    async list() {
      return { data: [...sessions.values()].map((record) => record.info), cursor: {} }
    },

    async context(contextInput) {
      return [...mustRecord(contextInput.sessionID).context]
    },

    async prompt(promptInput) {
      const record = mustRecord(promptInput.sessionID)
      sequence += 1
      const messageID = `msg_${sequence}`
      const delivery = promptInput.delivery ?? "steer"
      const inbox: SessionInboxUser = {
        id: messageID,
        sessionID: promptInput.sessionID,
        time: { created: scheduler.now() },
        type: "user",
        payload: {
          text: promptInput.text,
          files: [],
          metadata: promptInput.metadata ? { ...promptInput.metadata } : undefined,
        },
        delivery,
      }
      record.prompts.push(inbox)
      record.busy = true
      record.info.time.busy = scheduler.now()
      touch(record)
      if (!isInternalAdmission(promptInput.metadata)) {
        const event: FakeSessionPromptEvent = {
          sessionID: promptInput.sessionID,
          messageID,
          prompt: {
            text: promptInput.text,
            files: promptInput.files,
            agents: promptInput.agents,
            skills: promptInput.skills,
          },
          metadata: promptInput.metadata,
          delivery,
        }
        await registry.fire("session", "prompt", event)
      }
      return inbox
    },

    async interrupt(interruptInput) {
      const record = mustRecord(interruptInput.sessionID)
      const interrupted = record.busy
      record.busy = false
      record.info.time.busy = undefined
      record.info.time.idle = scheduler.now()
      touch(record)
      return { interrupted }
    },

    async update(updateInput) {
      const record = mustRecord(updateInput.sessionID)
      if (updateInput.title !== undefined) record.info.title = updateInput.title
      if (updateInput.metadata !== undefined) {
        record.info.metadata = { ...record.info.metadata, ...updateInput.metadata }
      }
      if (updateInput.archived !== undefined) record.info.time.archived = scheduler.now()
      touch(record)
    },

    async hook(name, callback, hookOptions) {
      return registry.registerHook("session", name, callback, hookOptions)
    },
  }

  return { domain, sessions }
}
