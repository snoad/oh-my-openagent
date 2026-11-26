// markHook (plan task 13): logs the "[opencode-v2] hook <name> fired" marker
// once per session per hook. The later adapter registrations call it on every
// V1 handler invocation and the live runner greps the marker out of the
// sandboxed plugin log as the "hook fired" proof.

const markedHooks = new Set<string>()

export function markHook(name: string, sessionID: string): void {
  const key = `${sessionID}:${name}`
  if (markedHooks.has(key)) return
  markedHooks.add(key)
  console.log(`[opencode-v2] hook ${name} fired`)
}

export function resetV2HookMarkersForTesting(): void {
  markedHooks.clear()
}
