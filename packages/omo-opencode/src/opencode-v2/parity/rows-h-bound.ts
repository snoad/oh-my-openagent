import { defineGroup, type ParityRow } from "./rows"

// Wave-0 boundary rows stay pending with no check until task 6 attaches their
// checks through V2/v2-boundary.test.ts. The six rows map one-to-one onto the
// boundary rules (a) to (f) of that todo.
export const hBoundRows: ParityRow[] = defineGroup("H-BOUND", [
  {
    suffix: "IMPORT-DIRECTION",
    title: "no file under SRC outside V2 imports from opencode-v2/ except the three entry seams",
    kind: "hermetic",
    is: ["IS-12", "IS-16"],
    wave: 0,
  },
  {
    suffix: "PLUGIN-RUNTIME-IMPORTS",
    title: "inside V2 the only @opencode runtime imports are the two define leaf modules",
    kind: "hermetic",
    is: ["IS-12", "IS-16"],
    wave: 0,
  },
  {
    suffix: "EFFECT-BAN",
    title: "no file under V2 imports effect",
    kind: "hermetic",
    is: ["IS-12", "IS-16"],
    wave: 0,
  },
  {
    suffix: "NAMING",
    title: "every file under V2 is kebab-case with no catch-all file names",
    kind: "hermetic",
    is: ["IS-12", "IS-16"],
    wave: 0,
  },
  {
    suffix: "FILE-SIZE",
    title: "non-test files under V2 stay within 200 lines and test files within 400",
    kind: "hermetic",
    is: ["IS-12", "IS-16"],
    wave: 0,
  },
  {
    suffix: "ENTRY-HASHES",
    title: "SRC/index.ts and SRC/tui.ts stay byte-identical to the recorded hashes",
    kind: "hermetic",
    is: ["IS-12", "IS-16"],
    wave: 0,
  },
])
