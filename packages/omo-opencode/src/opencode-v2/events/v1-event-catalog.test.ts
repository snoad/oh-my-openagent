import { describe, expect, it, setDefaultTimeout } from "bun:test"

import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import * as ts from "typescript/unstable/ast"
import type { SourceFile } from "typescript/unstable/ast"
import { TypeScriptSourceParser } from "../../shared/typescript-native-source-parser"
import { V1_EVENT_CATALOG, V1_EVENTS_NOT_PRODUCED_ON_V2, v2SubscriptionTypes } from "./v1-event-catalog"

// Completeness test of the V1 event catalog (plan task 14): with the native
// TypeScript parser, scan every non-test .ts under SRC/hooks, SRC/features,
// SRC/tools plus plugin/event.ts and plugin/event-*.ts for V1 event-type
// string literals compared against an event `type` (===, case, `type:`
// literals and the *_EVENT_TYPES collections) and assert each literal is
// either a catalog key or is listed in V1_EVENTS_NOT_PRODUCED_ON_V2.

setDefaultTimeout(process.platform === "win32" ? 60_000 : 30_000)

const SRC_ROOT = path.resolve(import.meta.dir, "../..")
const WORKSPACE_ROOT = repoRootFrom(SRC_ROOT)
const DOTTED_EVENT_NAME = /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/
const FILE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "jsonc",
  "md",
  "mdc",
  "txt",
  "png",
  "jpg",
  "pdf",
  "sock",
  "exe",
  "jsonl",
  "py",
  "lock",
  "lockb",
])
const PRE_FILTER = /(\.type|eventType)\s*(===|!==|==|!=)\s*"[^"]+"|case\s+"[^"]+":|type:\s*"[^"]+"|_EVENT_TYPES/

function repoRootFrom(start: string): string {
  let dir = start
  for (;;) {
    if (existsSync(path.join(dir, "bun.lock")) || existsSync(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error("repo root sentinel not found")
    dir = parent
  }
}

async function listScanFiles(): Promise<string[]> {
  const roots = ["hooks", "features", "tools"].map((dir) => path.join(SRC_ROOT, dir))
  const files: string[] = []
  for (const root of roots) files.push(...(await listNonTestTs(root)))
  const pluginDir = path.join(SRC_ROOT, "plugin")
  for (const name of await readdir(pluginDir)) {
    if (name !== "event.ts" && !name.startsWith("event-")) continue
    if (name.endsWith(".test.ts") || !name.endsWith(".ts")) continue
    files.push(path.join(pluginDir, name))
  }
  return files
}

async function listNonTestTs(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) return listNonTestTs(entryPath)
      return entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".d.ts")
        ? [entryPath]
        : []
    }),
  )
  return nested.flat()
}

function looksLikeEventName(literal: string): boolean {
  if (!DOTTED_EVENT_NAME.test(literal)) return false
  const segments = literal.split(".")
  return !FILE_EXTENSIONS.has(segments[segments.length - 1])
}

function isTypeExpression(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === "type" || node.text === "eventType"
  return ts.isPropertyAccessExpression(node) && node.name.text === "type"
}

// TS 7 native operator tokens carry no `.text`; the operator is the token's
// kind (EqualsEqualsEqualsToken & friends), so the comparison set matches on
// SyntaxKind. A `.text`-based set silently matches nothing, which is how the
// binary-comparison shape was lost.
const COMPARISON_OPERATOR_KINDS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
])

function collectEventLiterals(sourceFile: SourceFile): Map<string, string[]> {
  const hits = new Map<string, string[]>()
  const where = (node: ts.Node) => `${path.relative(SRC_ROOT, sourceFile.fileName)}:${lineOf(sourceFile, node)}`
  const record = (literal: string, node: ts.Node): void => {
    if (!looksLikeEventName(literal)) return
    const existing = hits.get(literal) ?? []
    existing.push(where(node))
    hits.set(literal, existing)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && COMPARISON_OPERATOR_KINDS.has(node.operatorToken.kind)) {
      const literal = ts.isStringLiteral(node.left)
        ? node.left
        : ts.isStringLiteral(node.right)
          ? node.right
          : undefined
      const other = literal === node.left ? node.right : literal === node.right ? node.left : undefined
      if (literal !== undefined && other !== undefined && isTypeExpression(other)) record(literal.text, literal)
    } else if (ts.isSwitchStatement(node) && isTypeExpression(node.expression)) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression))
          record(clause.expression.text, clause.expression)
      }
    } else if (ts.isPropertyAssignment(node) && node.name.text === "type" && ts.isStringLiteral(node.initializer)) {
      record(node.initializer.text, node.initializer)
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text.endsWith("_EVENT_TYPES") &&
      node.initializer !== undefined
    ) {
      const collect = (child: ts.Node): void => {
        if (ts.isStringLiteral(child)) record(child.text, child)
        child.forEachChild(collect)
      }
      node.initializer.forEachChild(collect)
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return hits
}

function lineOf(sourceFile: SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

let scanCache: Promise<Map<string, string[]>> | undefined

function scanEventLiterals(): Promise<Map<string, string[]>> {
  scanCache ??= runScan()
  return scanCache
}

async function runScan(): Promise<Map<string, string[]>> {
  const candidates: string[] = []
  for (const filePath of await listScanFiles()) {
    if (PRE_FILTER.test(await readFile(filePath, "utf8"))) candidates.push(filePath)
  }
  const parser = new TypeScriptSourceParser(WORKSPACE_ROOT)
  let parsed: ReadonlyMap<string, SourceFile>
  try {
    parsed = await parser.parse(candidates)
  } finally {
    await parser.close()
  }
  const hits = new Map<string, string[]>()
  for (const filePath of candidates) {
    const sourceFile = parsed.get(filePath)
    if (!sourceFile) throw new Error(`TypeScript did not parse ${filePath}`)
    for (const [literal, locations] of collectEventLiterals(sourceFile)) {
      hits.set(literal, [...(hits.get(literal) ?? []), ...locations])
    }
  }
  return hits
}

describe("v1-event-catalog completeness", () => {
  it("catalogues every V1 event-type literal in the scanned engine paths", async () => {
    // given
    const literals = await scanEventLiterals()

    // when / then
    expect(literals.size, "the scan should find V1 event literals").toBeGreaterThan(0)
    for (const [literal, locations] of literals) {
      const catalogued = V1_EVENT_CATALOG[literal] !== undefined
      const excluded = V1_EVENTS_NOT_PRODUCED_ON_V2[literal] !== undefined
      expect(
        catalogued || excluded,
        `${literal} (${locations.join(", ")}) is neither a V1_EVENT_CATALOG key nor listed in V1_EVENTS_NOT_PRODUCED_ON_V2`,
      ).toBe(true)
    }
  })

  it("keeps the scan honest by finding the known engine literals", async () => {
    // given
    const literals = await scanEventLiterals()

    // when / then
    for (const literal of [
      "session.idle",
      "session.error",
      "message.updated",
      "message.part.updated",
      "tool.execute.before",
    ]) {
      expect(literals.has(literal), `${literal} should be found by the scan`).toBe(true)
    }
  })

  it("gives every catalog entry a mode and non-empty reason when ignored", () => {
    // given / when / then
    for (const [key, entry] of Object.entries(V1_EVENT_CATALOG)) {
      expect(["synthesized", "passthrough", "ignored"], `${key} mode`).toContain(entry.mode)
      if (entry.mode === "ignored") expect(entry.reason, `${key} ignored reason`).toBeTruthy()
      if (entry.mode === "synthesized") expect(entry.v2Sources.length, `${key} sources`).toBeGreaterThan(0)
      if (entry.mode === "passthrough") expect(entry.v2Sources, `${key} sources`).toContain(key)
    }
  })

  it("excludes the V1 tui events with a reason", () => {
    // given / when / then
    expect(Object.keys(V1_EVENTS_NOT_PRODUCED_ON_V2).every((key) => key.startsWith("tui."))).toBe(true)
    for (const reason of Object.values(V1_EVENTS_NOT_PRODUCED_ON_V2)) expect(reason.length).toBeGreaterThan(0)
  })

  it("derives a duplicate-free subscription list from the catalog sources", () => {
    // given
    const types = v2SubscriptionTypes()

    // when / then
    expect(new Set(types).size, "subscription types must be unique").toBe(types.length)
    for (const entry of Object.values(V1_EVENT_CATALOG)) {
      for (const source of entry.v2Sources) expect(types, `${source} must be subscribable`).toContain(source)
    }
    expect(types).toContain("session.status")
    expect(types).toContain("session.execution.failed")
  })
})
