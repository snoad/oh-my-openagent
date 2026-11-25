import { defineGroup, type ParityRow } from "./rows"

// Wave-1 fake ctx contract rows. Their substrate (fake-v2-context.ts) and their
// flipper are task 9, so they are pending with no check at the wave-0 gate.
export const hFakeRows: ParityRow[] = defineGroup("H-FAKE", [
  {
    suffix: "HOOK-REGISTRY",
    title: "the fake ctx runs registered hooks in registration order and propagates rejections",
    kind: "hermetic",
    is: ["IS-13"],
    wave: 1,
  },
  {
    suffix: "TRANSFORM-REPLAY",
    title: "the fake ctx replays captured transforms in registration order onto a fresh value",
    kind: "hermetic",
    is: ["IS-13"],
    wave: 1,
  },
  {
    suffix: "SESSION-STORE",
    title: "the fake ctx backs the session methods with an in-memory store",
    kind: "hermetic",
    is: ["IS-13"],
    wave: 1,
  },
  {
    suffix: "EVENT-STREAM",
    title: "the fake ctx feeds every active event subscriber and honors type filters",
    kind: "hermetic",
    is: ["IS-13"],
    wave: 1,
  },
  {
    suffix: "ABORT",
    title: "the fake ctx aborts event subscriptions through their signal",
    kind: "hermetic",
    is: ["IS-13"],
    wave: 1,
  },
  {
    suffix: "PROMPT-HOOK-TAG",
    title:
      "the fake session.prompt fires the prompt hook unless the admission carries the omo.internal tag",
    kind: "hermetic",
    is: ["IS-13"],
    wave: 1,
  },
])
