import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

// Filesystem boundary rules (d) to (f) of the opencode-v2-compat plan, task 6. The
// import-boundary rules (a) to (c) live in v2-boundary-imports.ts; both are attached
// to the H-BOUND parity rows by parity/rows-h-bound.ts. This module must not import
// parity/rows.ts (rows.ts already imports rows-h-bound.ts, which imports this module).

export type BoundaryRuleResult = {
  readonly rule: string
  readonly violations: readonly string[]
}

const V2_ROOT = import.meta.dir
const SRC_ROOT = path.resolve(V2_ROOT, "..")
const ENTRY_HASH_LEDGER_PATH = path.join(V2_ROOT, "parity", "entry-files.sha256")

// (d) Catch-all file names banned by the root AGENTS.md conventions.
const CATCH_ALL_BASENAMES = new Set(["utils.ts", "helpers.ts", "service.ts"])
const CATCH_ALL_STEMS = new Set(["utils", "helpers", "service"])
const KEBAB_CASE_FILE_RE = /^[a-z0-9][a-z0-9.-]*$/

// (e) Line limits, mirroring the repo-wide soft limits.
const MAX_PRODUCTION_LINES = 200
const MAX_TEST_LINES = 400

async function listV2Files(): Promise<string[]> {
  return listV2FilesIn(V2_ROOT)
}

async function listV2FilesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) return listV2FilesIn(entryPath)
      return entry.isFile() ? [entryPath] : []
    }),
  )
  return nested.flat()
}

function relFromSrc(filePath: string): string {
  return path.relative(SRC_ROOT, filePath).split(path.sep).join("/")
}

function isProductionFile(filePath: string): boolean {
  return !path.basename(filePath).endsWith(".test.ts")
}

// (d) NAMING
export async function runNamingRule(): Promise<BoundaryRuleResult> {
  const violations: string[] = []
  for (const filePath of await listV2Files()) {
    const basename = path.basename(filePath)
    const stem = basename.replace(/\.ts$/, "")
    if (CATCH_ALL_BASENAMES.has(basename) || CATCH_ALL_STEMS.has(stem)) {
      violations.push(`${relFromSrc(filePath)} rule NAMING: catch-all file name ${basename} is banned`)
    } else if (!KEBAB_CASE_FILE_RE.test(basename)) {
      violations.push(`${relFromSrc(filePath)} rule NAMING: ${basename} is not kebab-case`)
    }
  }
  return { rule: "NAMING", violations }
}

// (e) FILE-SIZE
export async function runFileSizeRule(): Promise<BoundaryRuleResult> {
  const violations: string[] = []
  const tsFiles = (await listV2Files()).filter((filePath) => {
    const basename = path.basename(filePath)
    return basename.endsWith(".ts") && !basename.endsWith(".d.ts")
  })
  for (const filePath of tsFiles) {
    const content = await readFile(filePath, "utf8")
    const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0)
    const limit = isProductionFile(filePath) ? MAX_PRODUCTION_LINES : MAX_TEST_LINES
    if (lines > limit) {
      violations.push(`${relFromSrc(filePath)} rule FILE-SIZE: ${lines} lines exceeds the ${limit}-line limit`)
    }
  }
  return { rule: "FILE-SIZE", violations }
}

// (f) ENTRY-HASHES
export async function runEntryHashRule(): Promise<BoundaryRuleResult> {
  const violations: string[] = []
  const ledger = await readFile(ENTRY_HASH_LEDGER_PATH, "utf8")
  for (const rawLine of ledger.split("\n")) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith("#")) continue
    const separator = line.indexOf("  ")
    const recorded = separator === -1 ? "" : line.slice(0, separator)
    const relativePath = separator === -1 ? "" : line.slice(separator + 2).trim()
    const entryPath = path.join(SRC_ROOT, relativePath)
    if (recorded.length !== 64 || relativePath.length === 0 || !existsSync(entryPath)) {
      violations.push(
        `opencode-v2/parity/entry-files.sha256 rule ENTRY-HASHES: malformed or missing ledger entry "${line}"`,
      )
      continue
    }
    const actual = createHash("sha256")
      .update(await readFile(entryPath))
      .digest("hex")
    if (actual !== recorded) {
      violations.push(`${relativePath} rule ENTRY-HASHES: sha256 ${actual} does not match the recorded ${recorded}`)
    }
  }
  return { rule: "ENTRY-HASHES", violations }
}
