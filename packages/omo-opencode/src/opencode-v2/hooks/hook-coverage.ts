import type { CreatedHooks } from "../../create-hooks"
import { V2_LIMITS } from "../parity/v2-limits"

// Hook reachability ledger (plan task 19). The wave suites drive the real
// engine over the hermetic ctx with every composed hook record wrapped in an
// invocation spy; the ledger classifies every key of the createHooks result.
// The keys come from Object.keys of the tier records, never from a documented
// count (the AGENTS counts disagree). The wave suites assert each key marked
// reachable with coverageWave <= LANDED_WAVES has invoked === true, so the
// assertion tightens automatically as the wave gate bumps LANDED_WAVES; a key
// that turns out unreachable on OpenCode 2 must be flipped with the limit id
// that documents the gap.

export type V2HookCoverageStatus = "reachable" | "unreachable-on-v2"

export type V2HookCoverageEntry = {
  readonly key: string
  readonly status: V2HookCoverageStatus
  readonly coverageWave?: number
  readonly limitId?: string
  readonly note?: string
}

const REACHABLE_2 = (key: string): V2HookCoverageEntry => ({
  key,
  status: "reachable",
  coverageWave: 2,
})

const REACHABLE_4 = (key: string, note: string): V2HookCoverageEntry => ({
  key,
  status: "reachable",
  coverageWave: 4,
  note,
})

const COVERAGE_LEDGER_KEYS: readonly V2HookCoverageEntry[] = [
  REACHABLE_2("agentUsageReminder"),
  REACHABLE_2("anthropicContextWindowLimitRecovery"),
  REACHABLE_2("astGrepSgProvision"),
  REACHABLE_2("atlasHook"),
  REACHABLE_2("autoSlashCommand"),
  REACHABLE_2("backgroundNotificationHook"),
  REACHABLE_2("categorySkillReminder"),
  REACHABLE_2("claudeCodeHooks"),
  REACHABLE_2("compactionContextInjector"),
  REACHABLE_2("compactionTodoPreserver"),
  REACHABLE_2("directoryReadmeInjector"),
  REACHABLE_2("hephaestusAgentsMdInjector"),
  REACHABLE_2("keywordDetector"),
  REACHABLE_2("legacyPluginToast"),
  REACHABLE_2("nativeEditionNudge"),
  REACHABLE_2("rulesInjector"),
  REACHABLE_2("runtimeFallback"),
  REACHABLE_2("sessionNotification"),
  REACHABLE_2("stopContinuationGuard"),
  REACHABLE_2("thinkMode"),
  REACHABLE_2("todoContinuationEnforcer"),
  REACHABLE_2("unstableAgentBabysitter"),
  REACHABLE_2("writeExistingFileGuard"),
  {
    key: "autoUpdateChecker",
    status: "unreachable-on-v2",
    limitId: "LIM-18",
    note: "inert on OpenCode 2 because the host owns plugin updates",
  },
  REACHABLE_4("bashFileReadGuard", "tool.execute.before surface, wave-4 suite"),
  REACHABLE_4("btwSideContextInjector", "messages.transform surface, wave-4 suite"),
  REACHABLE_4("commentChecker", "tool.execute surface, wave-4 suite"),
  REACHABLE_4("contextInjectorMessagesTransform", "messages.transform surface, wave-4 suite"),
  REACHABLE_4("delegateTaskRetry", "tool.execute.after surface, wave-4 suite"),
  REACHABLE_4("directoryAgentsInjector", "config-gated tool injector, wave-4 suite"),
  REACHABLE_4("editErrorRecovery", "tool.execute.after surface, wave-4 suite"),
  REACHABLE_4("emptyTaskResponseDetector", "tool.execute.after surface, wave-4 suite"),
  REACHABLE_4("fsyncSkipWarning", "tool.execute surface, wave-4 suite"),
  REACHABLE_4("goal", "config-gated idle continuation, wave-4 suite"),
  REACHABLE_4("hashlineReadEnhancer", "tool.execute.after surface, wave-4 suite"),
  REACHABLE_4("interactiveBashSession", "config-gated tmux session hook, wave-4 suite"),
  REACHABLE_4("jsonErrorRecovery", "tool.execute.after surface, wave-4 suite"),
  REACHABLE_4("modelFallback", "config-gated chat.params hook, wave-4 suite"),
  REACHABLE_4("momusReviewPersistence", "tool.execute surface, wave-4 suite"),
  REACHABLE_4("monitorStatusInjector", "config-gated monitor transform, wave-4 suite"),
  REACHABLE_4("noHephaestusNonGpt", "chat.message surface, wave-4 suite"),
  REACHABLE_4("noSisyphusGpt", "chat.message surface, wave-4 suite"),
  REACHABLE_4("nonInteractiveEnv", "tool.execute.before surface, wave-4 suite"),
  REACHABLE_4("notepadWriteGuard", "tool.execute.before surface, wave-4 suite"),
  REACHABLE_4("planFormatValidator", "tool.execute.after surface, wave-4 suite"),
  REACHABLE_4("preemptiveCompaction", "config-gated idle hook, wave-4 suite"),
  REACHABLE_4("prometheusMdOnly", "tool.execute.before surface, wave-4 suite"),
  REACHABLE_4("questionLabelTruncator", "tool.execute.before surface, wave-4 suite"),
  REACHABLE_4("readImageResizer", "tool.execute.after surface, wave-4 suite"),
  REACHABLE_4("sisyphusJuniorNotepad", "tool.execute.before surface, wave-4 suite"),
  REACHABLE_4("taskResumeInfo", "tool.execute.after surface, wave-4 suite"),
  REACHABLE_4("tasksTodowriteDisabler", "tool.execute.before surface, wave-4 suite"),
  REACHABLE_4("teamMailboxInjector", "config-gated team transform, wave-4 suite"),
  REACHABLE_4("teamModeStatusInjector", "config-gated team transform, wave-4 suite"),
  REACHABLE_4("teamToolGating", "team tool gate, wave-4 suite"),
  REACHABLE_4("todoDescriptionOverride", "tool.definition surface, wave-4 suite"),
  REACHABLE_4("toolOutputTruncator", "tool.execute.after surface, wave-4 suite"),
  REACHABLE_4("toolPairValidator", "messages.transform surface, wave-4 suite"),
  REACHABLE_4("ulwExecute", "chat.message surface, wave-4 suite"),
  REACHABLE_4("webfetchRedirectGuard", "tool.execute surface, wave-4 suite"),
]

export const V2_HOOK_COVERAGE_LEDGER: readonly V2HookCoverageEntry[] = COVERAGE_LEDGER_KEYS

export type HookInvocationRecorder = {
  readonly record: (key: string) => void
  readonly invoked: (key: string) => boolean
  readonly count: (key: string) => number
}

export function createHookInvocationRecorder(): HookInvocationRecorder {
  const counts = new Map<string, number>()
  return {
    record: (key) => counts.set(key, (counts.get(key) ?? 0) + 1),
    invoked: (key) => (counts.get(key) ?? 0) > 0,
    count: (key) => counts.get(key) ?? 0,
  }
}

function spyRecord(
  value: Record<string, unknown>,
  key: string,
  recorder: HookInvocationRecorder,
): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {}
  for (const [member, memberValue] of Object.entries(value)) {
    wrapped[member] =
      typeof memberValue !== "function"
        ? memberValue
        : (...args: unknown[]) => {
            recorder.record(key)
            return (memberValue as (...fnArgs: unknown[]) => unknown)(...args)
          }
  }
  return wrapped
}

export function spyCreatedHooks(hooks: CreatedHooks, recorder: HookInvocationRecorder): CreatedHooks {
  const spied: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(hooks)) {
    if (key === "disposeHooks" || value === null || value === undefined) {
      spied[key] = value
    } else if (typeof value === "function") {
      const fn = value as (...fnArgs: unknown[]) => unknown
      spied[key] = (...fnArgs: unknown[]) => {
        recorder.record(key)
        return fn(...fnArgs)
      }
    } else if (typeof value === "object") {
      spied[key] = spyRecord(value as Record<string, unknown>, key, recorder)
    } else {
      spied[key] = value
    }
  }
  return spied as unknown as CreatedHooks
}

export function coverageLimitIds(): ReadonlySet<string> {
  return new Set(V2_LIMITS.map((limit) => limit.id))
}
