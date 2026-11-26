import type {
  AppAgentsData,
  AppAgentsResponses,
  ConfigGetData,
  ConfigGetResponses,
  NotFoundError,
  ProviderListData,
  ProviderListResponses,
  SessionAbortData,
  SessionAbortErrors,
  SessionAbortResponses,
  SessionChildrenData,
  SessionChildrenErrors,
  SessionChildrenResponses,
  SessionCreateData,
  SessionCreateErrors,
  SessionCreateResponses,
  SessionDeleteData,
  SessionDeleteErrors,
  SessionDeleteResponses,
  SessionGetData,
  SessionGetErrors,
  SessionGetResponses,
  SessionListData,
  SessionListResponses,
  SessionMessageData,
  SessionMessageErrors,
  SessionMessagesData,
  SessionMessagesErrors,
  SessionPromptAsyncData,
  SessionPromptAsyncErrors,
  SessionPromptAsyncResponses,
  SessionPromptData,
  SessionPromptErrors,
  SessionStatusErrors,
  SessionStatusResponses,
  SessionSummarizeData,
  SessionSummarizeErrors,
  SessionSummarizeResponses,
  SessionTodoData,
  SessionTodoResponses,
  TuiShowToastData,
  TuiShowToastResponses,
} from "@opencode-ai/sdk"
import type { V1MessageWithParts } from "./shape-codec-types"

// The V1 client surface the engine calls, expressed through the @opencode-ai/sdk
// operation types (Data minus the url template key; Responses/Errors unions).
// The SDK class methods are generic over ThrowOnError, so a concrete
// fields-form implementation cannot satisfies them directly (probed during
// task 12: the conditional return type rejects the fields union). This surface
// is the ThrowOnError=false projection of the same operations, which keeps the
// seam checked: a shape drift in the pinned SDK breaks this module's build.
// The three message-shaped returns use the task-11 V1 message mirror
// (V1MessageWithParts): the strict V1 Message type requires fields (user
// agent/model, assistant parentID/mode/path) the OpenCode 2 session context
// cannot always populate, and the engine readers read them tolerantly.

type OmitUrl<TData> = Omit<TData, "url">
type V1ResponseOf<TResponses> = TResponses[keyof TResponses]
type V1ErrorOf<TErrors> = TErrors[keyof TErrors]

export type V1Envelope<TData, TError = never> = (
  | { readonly data: TData; readonly error: undefined }
  | { readonly data: undefined; readonly error: TError }
) & { readonly request: Request; readonly response: Response }

export type V1FieldsResult<TResponses, TErrors = Record<never, never>> = Promise<
  V1Envelope<V1ResponseOf<TResponses>, V1ErrorOf<TErrors>>
>

const V1_SYNTHETIC_ORIGIN = "http://opencode-v2-shim.internal"

export function v1Success<TData>(data: TData, route: string, status = 200): V1Envelope<TData, never> {
  return {
    data,
    error: undefined,
    request: new Request(`${V1_SYNTHETIC_ORIGIN}${route}`),
    response: new Response(null, { status }),
  }
}

export function v1NotFound(message: string, route: string): V1Envelope<never, NotFoundError> {
  const error: NotFoundError = { name: "NotFoundError", data: { message } }
  return {
    data: undefined,
    error,
    request: new Request(`${V1_SYNTHETIC_ORIGIN}${route}`),
    response: new Response(null, { status: 404 }),
  }
}

export type V1SessionShimSurface = {
  readonly promptAsync: (options: OmitUrl<SessionPromptAsyncData>) => V1FieldsResult<SessionPromptAsyncResponses, SessionPromptAsyncErrors>
  // The V1 options chain extends RequestInit, so the sync prompt accepts the
  // standard abort signal; the shim honors it by interrupting the session.
  readonly prompt: (
    options: OmitUrl<SessionPromptData> & { readonly signal?: AbortSignal | null },
  ) => Promise<V1Envelope<V1MessageWithParts, V1ErrorOf<SessionPromptErrors>>>
  readonly messages: (options: OmitUrl<SessionMessagesData>) => Promise<V1Envelope<V1MessageWithParts[], V1ErrorOf<SessionMessagesErrors>>>
  readonly status: () => V1FieldsResult<SessionStatusResponses, SessionStatusErrors>
  readonly message: (options: OmitUrl<SessionMessageData>) => Promise<V1Envelope<V1MessageWithParts, V1ErrorOf<SessionMessageErrors>>>
  readonly abort: (options: OmitUrl<SessionAbortData>) => V1FieldsResult<SessionAbortResponses, SessionAbortErrors>
  readonly summarize: (options: OmitUrl<SessionSummarizeData>) => V1FieldsResult<SessionSummarizeResponses, SessionSummarizeErrors>
  readonly create: (options?: OmitUrl<SessionCreateData>) => V1FieldsResult<SessionCreateResponses, SessionCreateErrors>
  readonly list: (options?: OmitUrl<SessionListData>) => V1FieldsResult<SessionListResponses>
  readonly delete: (options: OmitUrl<SessionDeleteData>) => V1FieldsResult<SessionDeleteResponses, SessionDeleteErrors>
  readonly get: (options: OmitUrl<SessionGetData>) => V1FieldsResult<SessionGetResponses, SessionGetErrors>
  readonly children: (options: OmitUrl<SessionChildrenData>) => V1FieldsResult<SessionChildrenResponses, SessionChildrenErrors>
  readonly todo: (options: OmitUrl<SessionTodoData>) => V1FieldsResult<SessionTodoResponses>
}

export type V1ClientShimSurface = {
  readonly session: V1SessionShimSurface
  readonly tui: {
    readonly showToast: (options?: OmitUrl<TuiShowToastData>) => V1FieldsResult<TuiShowToastResponses>
  }
  readonly app: {
    readonly agents: (options?: OmitUrl<AppAgentsData>) => V1FieldsResult<AppAgentsResponses>
  }
  readonly provider: {
    readonly list: (options?: OmitUrl<ProviderListData>) => V1FieldsResult<ProviderListResponses>
  }
  readonly config: {
    readonly get: (options?: OmitUrl<ConfigGetData>) => V1FieldsResult<ConfigGetResponses>
  }
}
