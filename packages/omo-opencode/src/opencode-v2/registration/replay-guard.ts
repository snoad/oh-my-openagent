// Replay guard (task 23): wraps replay transform callback bodies in try/catch
// for tasks 24 to 28. On the OpenCode 2 host a single throwing transform
// disables the whole plugin, so a guarded callback logs one line and lets the
// replay continue with the unmodified value.

import { log } from "../../shared"

const LOG_MARKER = "[opencode-v2] plan-source"

// Registry-step form: a throwing recompute step is logged and skipped.
export function guardReplayStep<T>(
  label: string,
  run: (input: T) => void | Promise<void>,
): (input: T) => Promise<void> {
  return async (input) => {
    try {
      await run(input)
    } catch (error) {
      log(`${LOG_MARKER}: replay step ${label} failed; continuing with the unmodified value`, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

// Editor-callback form (ctx.agent.transform and friends): a throwing replay
// callback is logged and the unmodified editor value flows on.
export function guardReplayEditor<T>(label: string, transform: (value: T) => T): (value: T) => T {
  return (value) => {
    try {
      return transform(value)
    } catch (error) {
      log(`${LOG_MARKER}: replay transform ${label} failed; continuing with the unmodified value`, {
        error: error instanceof Error ? error.message : String(error),
      })
      return value
    }
  }
}
