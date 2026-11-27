import {
  AGENT_CANONICAL_ORDER,
  checkBuiltinDemotion,
  checkDefaultAgent,
  checkPromptBytes,
  checkRegistration,
  checkReplayIdempotent,
  checkSettleForeign,
  checkSettleReload,
} from "./rows-h-reg-agents-checks"
import { defineGroup, type ParityRow } from "./rows"

// Wave-3 H-REG agent rows (plan task 24): the omo agents registered on the
// OpenCode 2 agent editor through the plan source's agent step. The check
// bodies live in rows-h-reg-agents-checks.ts (each boots the real engine
// over the fixture-backed fake ctx); this file carries the row ledger.

const CANONICAL_ORDER = AGENT_CANONICAL_ORDER

export const hRegAgentRows: ParityRow[] = defineGroup("H-REG", [
  {
    suffix: "AGENT-REGISTRATION",
    title: `after boot the agent editor carries every plan agent exactly once in canonical order (${CANONICAL_ORDER.length} omo ids)`,
    kind: "hermetic",
    is: ["IS-2"],
    wave: 3,
    status: "checked",
    check: checkRegistration,
  },
  {
    suffix: "AGENT-REPLAY-IDEMPOTENT",
    title: "a second recompute leaves the registered agent shape unchanged",
    kind: "hermetic",
    is: ["IS-2"],
    wave: 3,
    status: "checked",
    check: checkReplayIdempotent,
  },
  {
    suffix: "AGENT-DEFAULT",
    title: "the applied default agent is the plan default under the canonical id",
    kind: "hermetic",
    is: ["IS-2"],
    wave: 3,
    status: "checked",
    check: checkDefaultAgent,
  },
  {
    suffix: "AGENT-BUILTIN-DEMOTION",
    title: "the built-in demotion flags match the V1 pipeline output",
    kind: "hermetic",
    is: ["IS-2"],
    wave: 3,
    status: "checked",
    check: checkBuiltinDemotion,
  },
  {
    suffix: "AGENT-PROMPT-BYTES",
    title: "every registered system prompt is byte-equal to the pipeline prompt artifact",
    kind: "hermetic",
    is: ["IS-2", "IS-5"],
    wave: 3,
    status: "checked",
    check: checkPromptBytes,
  },
  {
    suffix: "AGENT-SETTLE-RELOAD",
    title: "the reload-triggered recompute keeps the recorded base free of omo ids and the registry stable",
    kind: "hermetic",
    is: ["IS-2", "IS-5"],
    wave: 3,
    status: "checked",
    check: checkSettleReload,
  },
  {
    suffix: "AGENT-SETTLE-FOREIGN",
    title: "a foreign host agent change keeps every omo agent registered",
    kind: "hermetic",
    is: ["IS-2", "IS-5"],
    wave: 3,
    status: "checked",
    check: checkSettleForeign,
  },
])
