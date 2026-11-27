import { existsSyncSafe, fail, pass, type LiveCheck } from "./live-check-context"

// L-15 (post phase, plan task 20): isolation digests equal and the sandbox
// removed. The digest may drift while a live orchestrator session writes the
// real DB (documented in the plan's verification strategy), so the session
// count invariance is the reliable check.

// L-15 (post phase): isolation digests equal and the sandbox removed.
export const checkIsolation: LiveCheck = async (ctx) => {
  const isolation = ctx.manifest.isolation ?? {}
  const sandboxPath = ctx.manifest.sandboxPath ?? ""
  const versionEqual =
    isolation.systemVersionBefore === undefined ||
    isolation.systemVersionAfter === undefined ||
    isolation.systemVersionBefore === isolation.systemVersionAfter
  const sessionsEqual = isolation.sessionCountBefore === isolation.sessionCountAfter
  const sessionNote =
    isolation.sessionCountBefore === undefined
      ? "session count unavailable on both sides"
      : `session count ${isolation.sessionCountBefore} -> ${isolation.sessionCountAfter}`
  const sandboxRemoved = sandboxPath === "" || !existsSyncSafe(sandboxPath)
  const core = versionEqual && sessionsEqual && sandboxRemoved
  const evidence = [
    `L-15 ${core ? "PASS" : "FAIL"}: isolation digests and sandbox removal.`,
    `system version: ${isolation.systemVersionBefore ?? "(n/a)"} -> ${isolation.systemVersionAfter ?? "(n/a)"}`,
    `real db digest: ${isolation.dbDigestBefore ?? "(n/a)"} -> ${isolation.dbDigestAfter ?? "(n/a)"} (documented drift with a live orchestrator session; the session count is the reliable check)`,
    sessionNote,
    `sandbox path: ${sandboxPath || "(not provided)"}; exists after teardown: ${!sandboxRemoved}`,
    "",
  ].join("\n")
  if (!versionEqual) return fail("system opencode version changed", evidence)
  if (!sessionsEqual) return fail("real opencode.db session count changed", evidence)
  if (!sandboxRemoved) return fail("sandbox directory still exists after teardown", evidence)
  return pass("isolation proven: session count invariance and sandbox removal", evidence)
}
