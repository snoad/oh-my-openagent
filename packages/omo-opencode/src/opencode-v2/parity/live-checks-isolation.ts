import { existsSyncSafe, fail, pass, type LiveCheck } from "./live-check-context"

// L-15 (post phase, plan task 20): leak-based isolation. Unrelated sessions
// created by other processes during the run must NOT fail the row (their
// directories are recorded as ambient). A real leak FAILs: any real-DB
// session row whose directory lies inside the sandbox, a sandbox directory
// that still exists, or a changed system opencode version.

const AMBIENT_EVIDENCE_CAP = 40

// L-15 (post phase): leak-based isolation proof.
export const checkIsolation: LiveCheck = async (ctx) => {
  const isolation = ctx.manifest.isolation ?? {}
  const sandboxPath = ctx.manifest.sandboxPath ?? ""
  const versionRecorded = isolation.systemVersionBefore !== undefined && isolation.systemVersionAfter !== undefined
  const versionEqual = versionRecorded && isolation.systemVersionBefore === isolation.systemVersionAfter
  const leaks = isolation.leakedSessionDirectories
  const ambient = isolation.ambientSessionDirectories ?? []
  const sandboxRemoved = sandboxPath === "" || !existsSyncSafe(sandboxPath)
  const core = versionEqual && sandboxRemoved && leaks !== undefined && leaks.length === 0
  const evidence = [
    `L-15 ${core ? "PASS" : "FAIL"}: leak-based isolation and sandbox removal.`,
    `system version: ${isolation.systemVersionBefore ?? "(not recorded)"} -> ${isolation.systemVersionAfter ?? "(not recorded)"}`,
    `real db digest: ${isolation.dbDigestBefore ?? "(n/a)"} -> ${isolation.dbDigestAfter ?? "(n/a)"} (informational; ambient orchestrator activity may drift it)`,
    `real db session count: ${isolation.sessionCountBefore ?? "?"} -> ${isolation.sessionCountAfter ?? "?"} (informational; unrelated processes create sessions during the window)`,
    `leak method: ${isolation.method ?? "(not recorded)"}`,
    `leaked real-DB session rows (directory inside the sandbox): ${leaks === undefined ? "QUERY NOT RECORDED" : leaks.length === 0 ? "none" : leaks.join(", ")}`,
    `ambient real-DB sessions created during the window (not leaks): ${ambient.length}`,
    ...ambient.slice(0, AMBIENT_EVIDENCE_CAP).map((directory) => `  ambient directory: ${directory}`),
    `sandbox path: ${sandboxPath || "(not provided)"}; exists after teardown: ${!sandboxRemoved}`,
    "",
  ].join("\n")
  if (!versionRecorded)
    return fail("system opencode version not recorded on both sides (unchanged not proven)", evidence)
  if (!versionEqual) return fail("system opencode version changed", evidence)
  if (leaks === undefined) return fail("no real-DB leak query recorded (a leak cannot be ruled out)", evidence)
  if (leaks.length > 0)
    return fail(`${leaks.length} real-DB session row(s) created inside the sandbox (real leak)`, evidence)
  if (!sandboxRemoved) return fail("sandbox directory still exists after teardown", evidence)
  return pass(
    `isolation proven: no real-DB session leaked into the sandbox scope, version unchanged, sandbox removed (${ambient.length} ambient session(s) recorded)`,
    evidence,
  )
}
