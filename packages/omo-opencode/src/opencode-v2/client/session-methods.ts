import type { Session as V1Session, SessionStatus } from "@opencode-ai/sdk"
import type { SessionInfo } from "@opencode/client"
import type { V1SessionShimSurface } from "./v1-client-surface"
import { v1NotFound, v1Success } from "./v1-client-surface"
import { ensureSessionSnapshot, type SessionSnapshotCache } from "./session-snapshot-cache"
import type { V2ShimContext } from "./shim-context"
import { readSessionTodos } from "../registration/todo-store"

// Non-prompt session methods of the V2 client shim (plan task 12): each routes
// to the pinned 2.4.1 SessionDomain and answers in the V1 result envelope.
// session.status is the parameterless V1 form the prompt-async gate calls: a
// session-id keyed map, seeded through ctx.session.get (the 2.4.1 host emits
// no session.status events; plan task 14 will feed the same map from its
// subscription). session.children filters ctx.session.list() on the
// parent-linkage (SessionInfo.parentID today; task 30 enriches it with
// metadata) because 2.4.1 has no children method. session.todo serves the
// plugin todo store (task 29): the host ships no todo tool by default, so the
// todos live in the session metadata under the reserved omo.todos key.

const SESSION_ROUTE = "/session"
const SESSION_ID_ROUTE = "/session/{id}"
const CHILDREN_ROUTE = "/session/{id}/children"
const TODO_ROUTE = "/session/{id}/todo"
const STATUS_ROUTE = "/session/status"
const ABORT_ROUTE = "/session/{id}/abort"
const SUMMARIZE_ROUTE = "/session/{id}/summarize"
const MESSAGES_ROUTE = "/session/{id}/message"
const MESSAGE_ROUTE = "/session/{id}/message/{messageID}"

export type V1SessionLifecycleMethods = Pick<
  V1SessionShimSurface,
  "messages" | "status" | "message" | "abort" | "summarize" | "create" | "list" | "delete" | "get" | "children" | "todo"
>

function toV1Session(info: SessionInfo): V1Session {
  return {
    id: info.id,
    projectID: info.projectID,
    directory: info.location.directory,
    title: info.title ?? "",
    version: "",
    time: { created: info.time.created, updated: info.time.updated },
    ...(info.parentID === undefined ? {} : { parentID: info.parentID }),
  }
}

function sessionStatusOf(info: SessionInfo): SessionStatus {
  return info.time.busy !== undefined ? { type: "busy" } : { type: "idle" }
}

export function createSessionLifecycleMethods(
  ctx: V2ShimContext,
  cache: SessionSnapshotCache,
): V1SessionLifecycleMethods {
  const statusMap = new Map<string, SessionStatus>()

  return {
    async create(options) {
      const body = options?.body
      const directory = options?.query?.directory
      const info = await ctx.session.create({
        parentID: body?.parentID,
        title: body?.title,
        ...(directory === undefined ? {} : { location: { directory } }),
      })
      return v1Success(toV1Session(info), SESSION_ROUTE)
    },

    async list() {
      const response = await ctx.session.list()
      return v1Success(response.data.map(toV1Session), SESSION_ROUTE)
    },

    async get(options) {
      const info = await ctx.session.get({ sessionID: options.path.id })
      return v1Success(toV1Session(info), SESSION_ID_ROUTE)
    },

    async delete(options) {
      const remove = ctx.session.remove
      if (remove === undefined) return v1Success(false, SESSION_ID_ROUTE)
      await remove.call(ctx.session, { sessionID: options.path.id })
      return v1Success(true, SESSION_ID_ROUTE)
    },

    async children(options) {
      const response = await ctx.session.list()
      const children = response.data.filter((info) => info.parentID === options.path.id).map(toV1Session)
      return v1Success(children, CHILDREN_ROUTE)
    },

    async todo(options) {
      return v1Success(await readSessionTodos(ctx, options.path.id), TODO_ROUTE)
    },

    async status() {
      const response = await ctx.session.list()
      const statuses: Record<string, SessionStatus> = {}
      for (const listed of response.data) {
        const info = await ctx.session.get({ sessionID: listed.id })
        const status = sessionStatusOf(info)
        statusMap.set(listed.id, status)
        statuses[listed.id] = status
      }
      return v1Success(statuses, STATUS_ROUTE)
    },

    async message(options) {
      const pairs = await ensureSessionSnapshot(ctx, cache, options.path.id)
      const pair = pairs.find((candidate) => candidate.info.id === options.path.messageID)
      return pair === undefined
        ? v1NotFound(`message ${options.path.messageID} not found in session ${options.path.id}`, MESSAGE_ROUTE)
        : v1Success(pair, MESSAGE_ROUTE)
    },

    async messages(options) {
      const pairs = await ensureSessionSnapshot(ctx, cache, options.path.id)
      const limit = options?.query?.limit
      const data = limit === undefined ? [...pairs] : pairs.slice(-limit)
      return v1Success(data, MESSAGES_ROUTE)
    },

    async abort(options) {
      const response = await ctx.session.interrupt({ sessionID: options.path.id })
      return v1Success(response.interrupted, ABORT_ROUTE)
    },

    async summarize(options) {
      const compact = ctx.session.compact
      if (compact === undefined) return v1Success(false, SUMMARIZE_ROUTE)
      // The V1 providerID/modelID summarize-model selection cannot be
      // expressed: SessionCompactInput is { sessionID, id?, delivery? } and
      // OpenCode 2 compacts with the session's own model (candidate LIM-5).
      await compact.call(ctx.session, { sessionID: options.path.id })
      return v1Success(true, SUMMARIZE_ROUTE)
    },
  }
}
