import { defineGroup, type ParityRow } from "./rows"

// Wave-6 CLI rows for IS-10. They exist from wave 0 because the matrix
// invariant requires every IS-1..IS-17 to have at least one row, and IS-10 has
// no live row; tasks 41 and 42 attach their checks and flip them.
export const hCliRows: ParityRow[] = defineGroup("H-CLI", [
  {
    suffix: "DOCTOR",
    title: "doctor reports the OpenCode 2 host generation, version, floor support and plugin state",
    kind: "hermetic",
    is: ["IS-10"],
    wave: 6,
  },
  {
    suffix: "RUN-GUARD",
    title: "omo run refuses with a clear message on an OpenCode 2 host instead of starting a V1 server",
    kind: "hermetic",
    is: ["IS-10"],
    wave: 6,
  },
  {
    suffix: "CLEANUP",
    title: "cleanup removes the plugin entries from both config forms",
    kind: "hermetic",
    is: ["IS-10"],
    wave: 6,
  },
])
