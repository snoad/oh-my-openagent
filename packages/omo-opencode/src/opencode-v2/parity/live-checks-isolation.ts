import { existsSyncSafe, fail, pass, type LiveCheck } from "./live-check-context"

// L-15 (post phase, plan task 20): leak-based isolation. Unrelated sessions
// created by other processes during the run must NOT fail the row (their
// directories are recorded as ambient). A real leak FAILs: any real-DB
// session row whose directory lies inside the sandbox, a sandbox directory
// that still exists, or a changed system opencode version. When the runner
// has no system opencode at all (CI), the driver records systemOpencode
// "absent" and the version clause is not applicable.

const AMBIENT_EVIDENCE_CAP = 40

// L-15 (post phase): leak-based isolation proof.
export const checkIsolation: LiveCheck = async (ctx) => {
  const isolation = ctx.manifest.isolation ?? {}
  const sandboxPath = ctx.manifest.sandboxPath ?? ""
  const systemAbsent = isolation.systemOpencode === "absent"
  const versionRecorded =
    typeof isolation.systemVersionBefore === "string" && typeof isolation.systemVersionAfter === "string"
  const versionEqual = versionRecorded && isolation.systemVersionBefore === isolation.systemVersionAfter
  const versionClauseHolds = systemAbsent || versionEqual
  const leaks = isolation.leakedSessionDirectories
  const ambient = isolation.ambientSessionDirectories ?? []
  const sandboxRemoved = sandboxPath === "" || !existsSyncSafe(sandboxPath)
  const core = versionClauseHolds && sandboxRemoved && leaks !== undefined && leaks.length === 0
  const versionLine = systemAbsent
    ? "system opencode: absent on this runner (version clause not applicable)"
    : `system version: ${isolation.systemVersionBefore ?? "(not recorded)"} -> ${isolation.systemVersionAfter ?? "(not recorded)"}`
  const evidence = [
    `L-15 ${core ? "PASS" : "FAIL"}: leak-based isolation and sandbox removal.`,
    versionLine,
    `real db digest: ${isolation.dbDigestBefore ?? "(n/a)"} -> ${isolation.dbDigestAfter ?? "(n/a)"} (informational; ambient orchestrator activity may drift it)`,
    `real db session count: ${isolation.sessionCountBefore ?? "?"} -> ${isolation.sessionCountAfter ?? "?"} (informational; unrelated processes create sessions during the window)`,
    `leak method: ${isolation.method ?? "(not recorded)"}`,
    `leaked real-DB session rows (directory inside the sandbox): ${leaks === undefined ? "QUERY NOT RECORDED" : leaks.length === 0 ? "none" : leaks.join(", ")}`,
    `ambient real-DB sessions created during the window (not leaks): ${ambient.length}`,
    ...ambient.slice(0, AMBIENT_EVIDENCE_CAP).map((directory) => `  ambient directory: ${directory}`),
    `sandbox path: ${sandboxPath || "(not provided)"}; exists after teardown: ${!sandboxRemoved}`,
    "",
  ].join("\n")
  if (!versionClauseHolds && !versionRecorded)
    return fail("system opencode version not recorded on both sides (unchanged not proven)", evidence)
  if (!versionClauseHolds) return fail("system opencode version changed", evidence)
  if (leaks === undefined) return fail("no real-DB leak query recorded (a leak cannot be ruled out)", evidence)
  if (leaks.length > 0)
    return fail(`${leaks.length} real-DB session row(s) created inside the sandbox (real leak)`, evidence)
  if (!sandboxRemoved) return fail("sandbox directory still exists after teardown", evidence)
  const versionSummary = systemAbsent ? "system opencode absent on the runner" : "version unchanged"
  return pass(
    `isolation proven: no real-DB session leaked into the sandbox scope, ${versionSummary}, sandbox removed (${ambient.length} ambient session(s) recorded)`,
    evidence,
  )
}
