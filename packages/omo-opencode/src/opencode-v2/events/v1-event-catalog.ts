// V1 event catalog of the OpenCode 2 translation layer (plan task 14): one
// entry per V1 event type the V1 engine handles, mapping it to the OpenCode 2
// event types that produce it. The completeness test pins that every V1
// event-type literal referenced under SRC/hooks, SRC/features, SRC/tools and
// SRC/plugin/event*.ts is either a catalog key or is listed in
// V1_EVENTS_NOT_PRODUCED_ON_V2 with a reason.

export type V1EventCatalogMode = "synthesized" | "passthrough" | "ignored"

export type V1EventCatalogEntry = {
  readonly v2Sources: readonly string[]
  readonly mode: V1EventCatalogMode
  readonly reason?: string
}

// V2 event types whose arrival means the session transcript changed: each
// triggers a snapshot-diff update that emits message.updated,
// message.part.updated and message.removed.
const SNAPSHOT_DIFF_V2_SOURCES: readonly string[] = [
  "session.message.content.updated",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "session.step.started",
  "session.step.first-token",
  "session.step.streamed",
  "session.step.ended",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.inbox.delivered",
  "session.inbox.enqueued",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
]

const TOOL_HOOK_REASON =
  "V1 never emits these as events (they are hook names); the OpenCode 2 tool lifecycle is adapted through ctx.tool.hook instead"

export const V1_EVENT_CATALOG: Readonly<Record<string, V1EventCatalogEntry>> = {
  "session.created": {
    v2Sources: ["session.created", "session.renamed"],
    mode: "passthrough",
    reason:
      "session.renamed carries the title merged into the session info registry the emitted session.created event shares",
  },
  "session.deleted": { v2Sources: ["session.deleted"], mode: "passthrough" },
  "session.idle": {
    v2Sources: ["session.status", "session.idle"],
    mode: "synthesized",
    reason:
      "session.status with type idle emits session.idle and session.status; the schema's deprecated session.idle passes through when the host emits it",
  },
  "session.status": { v2Sources: ["session.status"], mode: "passthrough" },
  "session.error": { v2Sources: ["session.execution.failed", "session.step.failed"], mode: "synthesized" },
  "session.compaction.ended": {
    v2Sources: ["session.compaction.ended"],
    mode: "passthrough",
    reason:
      "not a V1 SDK member, but the runtime-fallback hook reads this exact type; the identical name passes through",
  },
  "session.compaction.failed": {
    v2Sources: ["session.compaction.failed"],
    mode: "passthrough",
    reason:
      "not a V1 SDK member, but the runtime-fallback hook reads this exact type; the identical name passes through",
  },
  "message.updated": { v2Sources: SNAPSHOT_DIFF_V2_SOURCES, mode: "synthesized" },
  "message.part.updated": { v2Sources: SNAPSHOT_DIFF_V2_SOURCES, mode: "synthesized" },
  "message.removed": { v2Sources: SNAPSHOT_DIFF_V2_SOURCES, mode: "synthesized" },
  "message.part.delta": {
    v2Sources: [],
    mode: "ignored",
    reason:
      "the snapshot diff emits message.part.updated for changed parts; V1 consumers treat both as streaming progress",
  },
  "message.part.removed": {
    v2Sources: [],
    mode: "ignored",
    reason:
      "the snapshot diff emits message.removed for disappeared messages and message.part.updated for surviving parts; V1 part removal has no V2 source",
  },
  "session.compacted": {
    v2Sources: [],
    mode: "ignored",
    reason:
      "no V1-name-identical V2 compaction event exists; the V2 compaction lifecycle passes through under its own names",
  },
  "session.stop": {
    v2Sources: [],
    mode: "ignored",
    reason: "no V2 source; terminal signals arrive as session.execution failures, interrupts or session.status",
  },
  "todo.updated": {
    v2Sources: [],
    mode: "ignored",
    reason: "the 2.4.1 event catalog has no todo lifecycle event",
  },
  "session.next.retried": {
    v2Sources: [],
    mode: "ignored",
    reason:
      "V2 session.retry.scheduled has no identical V1 name and is not translated; retry state reaches V1 through session.error",
  },
  "session.next.synthetic": {
    v2Sources: [],
    mode: "ignored",
    reason: "no identical V2 event; synthetic user input has no V1 message translation",
  },
  "session.next.tool.called": {
    v2Sources: [],
    mode: "ignored",
    reason:
      "V2 session.tool.called flows through the snapshot diff as message.part.updated, which the V1 background manager consumes directly",
  },
  "tool.execute.before": { v2Sources: [], mode: "ignored", reason: TOOL_HOOK_REASON },
  "tool.execute.after": { v2Sources: [], mode: "ignored", reason: TOOL_HOOK_REASON },
}

// V1 event types the engine can see on V1 hosts that the OpenCode 2 event
// stream never carries, with the reason. The tui.* family exists only in the
// V1 host process.
export const V1_EVENTS_NOT_PRODUCED_ON_V2: Readonly<Record<string, string>> = {
  "tui.prompt.append":
    "the OpenCode 2 event stream carries no tui.* events; the V1 TUI-side consumers never fire on V2",
  "tui.command.execute":
    "the OpenCode 2 event stream carries no tui.* events; the V1 TUI-side consumers never fire on V2",
  "tui.toast.show": "the OpenCode 2 event stream carries no tui.* events; the V1 TUI-side consumers never fire on V2",
  "tui.session.select":
    "the OpenCode 2 event stream carries no tui.* events; the V1 TUI-side consumers never fire on V2",
}

export function v2SubscriptionTypes(): readonly string[] {
  const types = new Set<string>()
  for (const entry of Object.values(V1_EVENT_CATALOG)) {
    for (const source of entry.v2Sources) types.add(source)
  }
  return [...types]
}

export function isSnapshotDiffV2Source(v2Type: string): boolean {
  return SNAPSHOT_DIFF_V2_SOURCES.includes(v2Type)
}
