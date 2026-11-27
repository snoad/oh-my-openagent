// Tool name aliases (plan task 15): maps the OpenCode 2 tool names carried by
// the tool hook events to the V1 names the engine's hooks key on. The
// classification table covers every tool of the recorded host-2.4.1 fixture
// (parity/fixtures/host-2.4.1/tools.json): shell routes to the V1 bash name so
// SRC/hooks/bash-file-read-guard.ts logic is reached, patch routes to edit,
// subagent routes to task (the V1 delegation guards). The mcp_ strip mirrors
// the V1 registry convention of SRC/plugin/tool-execute-before.ts:57-66 (the
// model may emit mcp_background_output while the registry name is
// background_output). Code Mode calls (codemode: true) route through the
// separate codemode table and otherwise pass the OpenCode 2 name unchanged, so
// name-keyed V1 guards do nothing for that call (LIM-19).

export type V2ToolNameClassification =
  | { readonly v2: string; readonly kind: "alias"; readonly v1: string }
  | { readonly v2: string; readonly kind: "unchanged" }
  | { readonly v2: string; readonly kind: "no-v1-equivalent" }

// One classification per tool of the host-2.4.1 tools.json fixture. The V1
// name universe is the task-3 v1-baseline tool list: no V1 execute,
// generate_image, generate_video or websearch exists, and the V1 names for
// shell/patch/subagent hook behavior are bash/edit/task.
export const V2_TOOL_NAME_CLASSIFICATIONS: readonly V2ToolNameClassification[] = [
  { v2: "execute", kind: "no-v1-equivalent" },
  { v2: "generate_image", kind: "no-v1-equivalent" },
  { v2: "generate_video", kind: "no-v1-equivalent" },
  { v2: "glob", kind: "unchanged" },
  { v2: "grep", kind: "unchanged" },
  { v2: "patch", kind: "alias", v1: "edit" },
  { v2: "question", kind: "unchanged" },
  { v2: "read", kind: "unchanged" },
  { v2: "shell", kind: "alias", v1: "bash" },
  { v2: "skill", kind: "unchanged" },
  { v2: "subagent", kind: "alias", v1: "task" },
  { v2: "webfetch", kind: "unchanged" },
  { v2: "websearch", kind: "no-v1-equivalent" },
]

const V2_TOOL_NAME_ALIASES: Readonly<Record<string, string>> = Object.fromEntries(
  V2_TOOL_NAME_CLASSIFICATIONS.flatMap((entry) => (entry.kind === "alias" ? [[entry.v2, entry.v1] as const] : [])),
)

// Code Mode calls carry their own call ids and possibly path-like tool names;
// only an explicit entry maps, everything else passes through unchanged. The
// table starts empty because the recorded host-2.4.1 fixtures carry no
// codemode: true tool event; a later wave that captures the naming populates
// it (LIM-19).
export const V2_CODEMODE_TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {}

export function toV1ToolName(v2Name: string): string {
  const stripped = v2Name.replace(/^mcp_/i, "")
  return V2_TOOL_NAME_ALIASES[stripped] ?? stripped
}

export function toV1ToolNameForCall(v2Name: string, codemode: boolean): string {
  if (!codemode) return toV1ToolName(v2Name)
  return V2_CODEMODE_TOOL_NAME_ALIASES[v2Name] ?? v2Name
}
