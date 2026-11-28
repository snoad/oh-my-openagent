import { expect } from "bun:test"
import { realpathSync } from "node:fs"

// The skill loader canonicalizes contributed paths with realpathSync.native
// (V1 behavior stays), so a seeded path only matches through its real form:
// on macOS /var resolves to /private/var and Windows short temp names
// (RUNNER~1) resolve to the long ones.
export function expectSameRealPath(actual: string | undefined, expected: string): void {
  if (actual === undefined) {
    expect(actual, "the contributed skill path is defined").toBeDefined()
    return
  }
  expect(realpathSync.native(actual)).toBe(realpathSync.native(expected))
}
