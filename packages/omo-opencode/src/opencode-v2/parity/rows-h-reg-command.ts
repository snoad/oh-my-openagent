import {
  checkCommandDefinitions,
  checkCommandReplayIdempotent,
  checkCommandSetParity,
} from "./rows-h-reg-command-checks"
import { defineGroup, type ParityRow } from "./rows"

// Wave-3 H-REG command rows (plan task 27): every V1 command entry maps onto
// the pinned OpenCode 2 definition with the right execute behavior, the
// registered set equals the V1 pipeline output on the same base and the
// committed fixture (the four intercepted names included), and replay is
// idempotent with the pristine record taken before any edit. The intercepted
// commands keep their V1 behavior through the task-16 prompt hook: the
// definition relays the slash name through the host admission, proven by the
// fake ctx prompt hook in COMMAND-DEFINITIONS and live by L-06's submission
// probe.
export const hRegCommandRows: ParityRow[] = defineGroup("H-REG", [
  {
    suffix: "COMMAND-DEFINITIONS",
    title:
      "each V1 command entry maps to the pinned definition: the template expands with the arguments and agent, the intercepted name relays its slash text",
    kind: "hermetic",
    is: ["IS-7"],
    wave: 3,
    status: "checked",
    check: checkCommandDefinitions,
  },
  {
    suffix: "COMMAND-SET-PARITY",
    title:
      "the registered command set equals the V1 pipeline output on the same base and equals the committed expected fixture",
    kind: "hermetic",
    is: ["IS-7"],
    wave: 3,
    status: "checked",
    check: checkCommandSetParity,
  },
  {
    suffix: "COMMAND-REPLAY",
    title: "replay twice yields the same command list and the pristine record lands before any edit",
    kind: "hermetic",
    is: ["IS-7"],
    wave: 3,
    status: "checked",
    check: checkCommandReplayIdempotent,
  },
])
