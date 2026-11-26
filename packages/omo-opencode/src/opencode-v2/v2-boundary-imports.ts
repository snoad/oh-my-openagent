import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import * as ts from "typescript/unstable/ast"
import type { SourceFile } from "typescript/unstable/ast"
import { TypeScriptSourceParser } from "../shared/typescript-native-source-parser"
import type { BoundaryRuleResult } from "./v2-boundary-rules"

// Import-boundary rules (a) to (c) of the opencode-v2-compat plan, task 6, attached by the parity rows in
// parity/rows-h-bound.ts (which imports this module, so this module must not import parity/rows.ts). Rule (b)
// scopes entry-file pinning to production files: the SDK surface test may runtime-import the two define leaves
// to pin them.

const IMPORT_RULE_IDS = ["IMPORT-DIRECTION", "PLUGIN-RUNTIME-IMPORTS", "EFFECT-BAN"] as const
export type ImportRuleId = (typeof IMPORT_RULE_IDS)[number]

type CollectedImport = { readonly module: string; readonly typeOnly: boolean; readonly line: number }

const V2_ROOT = import.meta.dir
const SRC_ROOT = path.resolve(V2_ROOT, "..")
const WORKSPACE_ROOT = repoRootFrom(SRC_ROOT)

// (a) The three seams through which the rest of SRC may reach opencode-v2/.
const IMPORT_DIRECTION_SEAM_PATHS = new Set([
  path.join(SRC_ROOT, "index.ts"),
  path.join(SRC_ROOT, "tui.ts"),
  path.join(SRC_ROOT, "index.export-shape.test.ts"),
])

// (b) The two define leaf modules of the OpenCode 2 SDK, pinned per production entry.
const PLUGIN_RUNTIME_ENTRY_PINNING = new Map([
  ["server-entry.ts", "@opencode/plugin/promise/plugin"],
  ["tui-entry.ts", "@opencode/plugin/tui/plugin"],
])
const PLUGIN_DEFINE_LEAF_MODULES = new Set(PLUGIN_RUNTIME_ENTRY_PINNING.values())
// (b) OpenTUI version conflict: repo pins @opentui/* ^0.5.11, the 2.4.1 SDK peers >=0.8.0, so the exact tui root module is forbidden everywhere.
const BANNED_TUI_MODULE = "@opencode/plugin/tui"

function repoRootFrom(start: string): string {
  let dir = start
  for (;;) {
    if (existsSync(path.join(dir, "bun.lock")) || existsSync(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error("repo root sentinel not found")
    dir = parent
  }
}

async function listTsFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) return listTsFiles(entryPath)
      const basename = entry.name
      return entry.isFile() && basename.endsWith(".ts") && !basename.endsWith(".d.ts") ? [entryPath] : []
    }),
  )
  return nested.flat()
}

function relFromSrc(filePath: string): string {
  return path.relative(SRC_ROOT, filePath).split(path.sep).join("/")
}

function isInsideV2(filePath: string): boolean {
  return !path.relative(V2_ROOT, filePath).startsWith("..")
}

function lineOf(sourceFile: SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

// Static imports, re-exports and dynamic import() specifiers, with their import kind.
function collectImports(sourceFile: SourceFile): CollectedImport[] {
  const collected: CollectedImport[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      collected.push({
        module: node.moduleSpecifier.text,
        typeOnly: node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword,
        line: lineOf(sourceFile, node),
      })
    } else if (ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier !== undefined && ts.isStringLiteral(specifier)) {
        collected.push({ module: specifier.text, typeOnly: node.isTypeOnly === true, line: lineOf(sourceFile, node) })
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      if (argument !== undefined && ts.isStringLiteral(argument)) {
        collected.push({ module: argument.text, typeOnly: false, line: lineOf(sourceFile, node) })
      }
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return collected
}

function pluginRuntimeViolationOf(filePath: string, module: string, typeOnly: boolean): string | null {
  if (typeOnly) {
    return module === "@opencode/plugin"
      ? null
      : `rule PLUGIN-RUNTIME-IMPORTS: type import of ${module} is not the allowed root type import`
  }
  if (!path.basename(filePath).endsWith(".test.ts")) {
    const pinned = PLUGIN_RUNTIME_ENTRY_PINNING.get(path.basename(filePath))
    return pinned === module
      ? null
      : `rule PLUGIN-RUNTIME-IMPORTS: runtime import of ${module}; production files may runtime-import only their pinned define leaf`
  }
  return PLUGIN_DEFINE_LEAF_MODULES.has(module)
    ? null
    : `rule PLUGIN-RUNTIME-IMPORTS: runtime import of ${module}; test files may runtime-import only the two define leaves`
}

// One parse serves rules (a) to (c); memoized per test process so the parity matrix and
// the boundary test share the result without re-spawning the TypeScript native process.
let importRulesCache: Promise<Record<ImportRuleId, string[]>> | undefined

function runImportBoundaryRules(): Promise<Record<ImportRuleId, string[]>> {
  importRulesCache ??= scanImportBoundaries()
  return importRulesCache
}

async function scanImportBoundaries(): Promise<Record<ImportRuleId, string[]>> {
  const violations: Record<ImportRuleId, string[]> = {
    "IMPORT-DIRECTION": [],
    "PLUGIN-RUNTIME-IMPORTS": [],
    "EFFECT-BAN": [],
  }
  const candidates: string[] = []
  for (const filePath of await listTsFiles(SRC_ROOT)) {
    const content = await readFile(filePath, "utf8")
    const inV2 = isInsideV2(filePath)
    const relevant =
      content.includes(BANNED_TUI_MODULE) ||
      (inV2 && (content.includes("@opencode") || content.includes("effect"))) ||
      (!inV2 && content.includes("opencode-v2"))
    if (relevant) candidates.push(filePath)
  }

  const parser = new TypeScriptSourceParser(WORKSPACE_ROOT)
  let parsed: ReadonlyMap<string, SourceFile>
  try {
    parsed = await parser.parse(candidates)
  } finally {
    await parser.close()
  }

  for (const filePath of candidates) {
    const sourceFile = parsed.get(filePath)
    if (!sourceFile) throw new Error(`TypeScript did not parse ${filePath}`)
    for (const imported of collectImports(sourceFile)) {
      const { module, typeOnly, line } = imported
      const where = `${relFromSrc(filePath)}:${line}`
      const inV2 = isInsideV2(filePath)

      // (a) IMPORT-DIRECTION
      if (!inV2 && module.includes("opencode-v2") && !IMPORT_DIRECTION_SEAM_PATHS.has(filePath)) {
        violations["IMPORT-DIRECTION"].push(
          `${where} rule IMPORT-DIRECTION: files outside opencode-v2/ must not import ${module}`,
        )
      }

      // (b) PLUGIN-RUNTIME-IMPORTS
      if (module === BANNED_TUI_MODULE) {
        violations["PLUGIN-RUNTIME-IMPORTS"].push(
          `${where} rule PLUGIN-RUNTIME-IMPORTS: ${module} is forbidden everywhere (OpenTUI version conflict)`,
        )
      } else if (module === "@opencode-ai" || module.startsWith("@opencode-ai/")) {
        if (!typeOnly && inV2) {
          violations["PLUGIN-RUNTIME-IMPORTS"].push(
            `${where} rule PLUGIN-RUNTIME-IMPORTS: runtime import of ${module} inside opencode-v2/`,
          )
        }
      } else if (module === "@opencode/plugin" || module.startsWith("@opencode/plugin/")) {
        const violation = pluginRuntimeViolationOf(filePath, module, typeOnly)
        if (violation !== null) violations["PLUGIN-RUNTIME-IMPORTS"].push(`${where} ${violation}`)
      }

      // (c) EFFECT-BAN
      if (inV2 && (module === "effect" || module.startsWith("effect/"))) {
        violations["EFFECT-BAN"].push(`${where} rule EFFECT-BAN: import of ${module} inside opencode-v2/`)
      }
    }
  }
  return violations
}

export async function importRuleResults(): Promise<Record<ImportRuleId, BoundaryRuleResult>> {
  const violations = await runImportBoundaryRules()
  return {
    "IMPORT-DIRECTION": { rule: "IMPORT-DIRECTION", violations: violations["IMPORT-DIRECTION"] },
    "PLUGIN-RUNTIME-IMPORTS": { rule: "PLUGIN-RUNTIME-IMPORTS", violations: violations["PLUGIN-RUNTIME-IMPORTS"] },
    "EFFECT-BAN": { rule: "EFFECT-BAN", violations: violations["EFFECT-BAN"] },
  }
}
