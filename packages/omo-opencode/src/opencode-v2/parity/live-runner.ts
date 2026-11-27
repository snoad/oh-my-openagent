// live-runner.ts (plan task 20): the live OpenCode 2 parity row runner. A bun
// SCRIPT, not a test: fetch and node:fs only, no raw Bun.* APIs (the
// opencode-adapter-bun-runtime-audit test enforces this). Imports PARITY_ROWS
// from the parity matrix, selects the live rows of waves at most --wave
// except L-17, L-18 and L-19 (owned by other scripts), executes one check per
// row id against the sandbox API, the fake model request log and the
// sandboxed plugin logs, writes one evidence file per row and a results.json
// summary. Every live row of the matrix appears in the summary: rows whose
// owning task has not landed report pending. --post re-evaluates L-15 plus
// the cleanup-stats rows L-11 and L-24 against the post-shutdown log copies
// and merges those verdicts into results.json. --strict exits non-zero when
// any selected row is partial, stop or pending.
//
// Usage (driven by .agents/skills/opencode-qa/scripts/v2-parity-live.sh):
//   bun live-runner.ts --wave 2 --api http://127.0.0.1:PORT --password PASS \
//     --plugin-log serve.out --host-log opencode.log --manifest runs.json \
//     --out <evidence-dir> [--post] [--strict]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { PARITY_ROWS } from "./rows"
import { awaitPluginActive } from "./live-check-api"
import {
  writeEvidenceFile,
  type LiveCheckContext,
  type LiveCheckOutcome,
  type LiveManifest,
} from "./live-check-context"
import { liveRowShouldExecute, resolveLiveCheck } from "./live-checks-registry"

export type RowPass = true | false | "partial" | "pending" | "stop"
export type RowResult = { row: string; wave: number; pass: RowPass; owner?: string; evidence: string; summary: string }

// Rows re-evaluated in the post phase against the post-shutdown log copies.
const POST_PHASE_ROWS = new Set(["L-15", "L-11", "L-24"])

function verdictLabel(pass: RowPass): string {
  return pass === true ? "PASS" : pass === false ? "FAIL" : String(pass).toUpperCase()
}

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === undefined || !key.startsWith("--")) continue
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) {
      args.set(key.slice(2), "true")
      continue
    }
    args.set(key.slice(2), value)
    index += 1
  }
  return args
}

function loadManifest(path: string): LiveManifest {
  const raw = readFileSync(path, "utf8")
  return JSON.parse(raw) as LiveManifest
}

function printUsageAndExit(code: number): never {
  process.stderr.write(
    [
      "usage: bun live-runner.ts --wave <n> --api <url> --password <pass> --plugin-log <file>",
      "       --host-log <file> --manifest <file> --out <dir> [--post] [--strict]",
      "",
    ].join("\n"),
  )
  process.exit(code)
}

function toResult(rowId: string, wave: number, outcome: LiveCheckOutcome, evidencePath: string): RowResult {
  const owner = typeof outcome.owner === "string" ? outcome.owner : undefined
  return {
    row: rowId,
    wave,
    pass: outcome.pass,
    ...(owner === undefined ? {} : { owner }),
    evidence: evidencePath,
    summary: outcome.summary,
  }
}

function mergedRowResults(existing: RowResult[], updates: RowResult[]): RowResult[] {
  const byRow = new Map(existing.map((result) => [result.row, result]))
  for (const update of updates) byRow.set(update.row, update)
  return [...byRow.values()].sort((left, right) => (left.row < right.row ? -1 : left.row > right.row ? 1 : 0))
}

function exitCodeOf(results: RowResult[], strict: boolean, wave: number): number {
  if (results.some((result) => result.pass === false)) return 1
  if (!strict) return 0
  const open = results.filter((result) => result.wave <= wave && result.pass !== true && result.pass !== false)
  return open.length > 0 ? 1 : 0
}

async function runChecks(ctx: LiveCheckContext, post: boolean): Promise<RowResult[]> {
  const results: RowResult[] = []
  for (const row of PARITY_ROWS) {
    if (row.kind !== "live") continue
    if (post && !POST_PHASE_ROWS.has(row.id)) continue
    let outcome: LiveCheckOutcome
    if (!post && row.id === "L-15") {
      outcome = {
        pass: "pending",
        summary: "L-15 runs in the post phase after teardown",
        evidence: "L-15 pending: the isolation and sandbox-removal check runs after the driver stopped the server.\n",
      }
    } else if (post || liveRowShouldExecute(row, ctx.wave)) {
      try {
        outcome = await resolveLiveCheck(row, ctx.wave)(ctx)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        outcome = {
          pass: false,
          summary: `check threw: ${detail}`,
          evidence: `${row.id} FAIL: check threw: ${detail}\n`,
        }
      }
      process.stdout.write(`${verdictLabel(outcome.pass)} ${row.id}: ${outcome.summary}\n`)
    } else {
      outcome = await resolveLiveCheck(row, ctx.wave)(ctx)
    }
    const evidencePath = writeEvidenceFile(ctx, row.id, outcome.evidence)
    results.push(toResult(row.id, row.wave, outcome, evidencePath))
  }
  return results
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const wave = Number(args.get("wave") ?? "2")
  const apiBase = args.get("api") ?? ""
  const password = args.get("password") ?? ""
  const pluginLog = args.get("plugin-log") ?? ""
  const hostLog = args.get("host-log") ?? ""
  const manifestPath = args.get("manifest") ?? ""
  const outDir = args.get("out") ?? ""
  const post = args.get("post") === "true"
  const strict = args.get("strict") === "true"
  if (apiBase === "" || manifestPath === "" || outDir === "" || pluginLog === "" || hostLog === "") {
    printUsageAndExit(2)
  }
  if (!existsSync(manifestPath)) {
    process.stderr.write(`live-runner: manifest not found: ${manifestPath}\n`)
    process.exit(2)
  }
  mkdirSync(outDir, { recursive: true })
  const manifest = loadManifest(manifestPath)
  const ctx: LiveCheckContext = {
    manifest,
    apiBase,
    password,
    pluginLogPath: pluginLog,
    hostLogPath: hostLog,
    outDir,
    wave,
    phase: post ? "post" : "live",
    pluginState: { active: true, waitedMs: 0, entryText: "" },
  }
  let results: RowResult[] = []
  if (!post) {
    ctx.pluginState = await awaitPluginActive(ctx, manifest.pluginId, 60_000)
  }
  const updates = await runChecks(ctx, post)
  const resultsPath = `${outDir}/results.json`
  if (post && existsSync(resultsPath)) {
    try {
      const existing = JSON.parse(readFileSync(resultsPath, "utf8")) as RowResult[]
      results = mergedRowResults(existing, updates)
    } catch {
      results = updates
    }
  } else {
    results = updates
  }
  writeFileSync(resultsPath, JSON.stringify(results, null, 2) + "\n")
  const failed = exitCodeOf(results, strict, wave)
  process.stdout.write(`live-runner: ${results.length} live rows reported to ${resultsPath}\n`)
  process.exit(failed)
}

await main()
