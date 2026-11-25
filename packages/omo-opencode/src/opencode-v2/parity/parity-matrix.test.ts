import { describe, expect, it } from "bun:test"

import { LANDED_WAVES } from "./lan"
import { ALL_IS_IDS, PARITY_ROWS } from "./rows"

describe("OpenCode 2 parity matrix", () => {
  it("keeps row ids unique", () => {
    // given
    const ids = PARITY_ROWS.map((row) => row.id)

    // when
    const uniqueIds = new Set(ids)

    // then
    expect(uniqueIds.size, `duplicate row ids: ${ids.join(", ")}`).toBe(ids.length)
  })

  it("covers every IS row with at least one parity row", () => {
    // given
    const covered = new Set<string>(PARITY_ROWS.flatMap((row) => row.is))

    // when / then
    for (const isId of ALL_IS_IDS) {
      expect(covered.has(isId), `${isId} has no parity row`).toBe(true)
    }
  })

  it("maps every row to at least one known IS", () => {
    // given
    const known = new Set<string>(ALL_IS_IDS)

    // when / then
    for (const row of PARITY_ROWS) {
      expect(row.is?.length ?? 0, `${row.id} maps to no IS`).toBeGreaterThan(0)
      for (const isId of row.is) {
        expect(known.has(isId), `${row.id} maps to unknown ${isId}`).toBe(true)
      }
    }
  })

  it("checks every landed hermetic row with a passing check", async () => {
    // given
    const landed = PARITY_ROWS.filter(
      (row) => row.kind === "hermetic" && row.wave <= LANDED_WAVES,
    )

    // when / then
    for (const row of landed) {
      expect(row.status, `${row.id} wave ${row.wave} is landed but pending`).toBe("checked")
      expect(typeof row.check, `${row.id} has no check`).toBe("function")
      await row.check?.()
    }
  })

  it("keeps every unlanded hermetic row pending without a check", () => {
    // given
    const unlanded = PARITY_ROWS.filter(
      (row) => row.kind === "hermetic" && row.wave > LANDED_WAVES,
    )

    // when / then
    for (const row of unlanded) {
      expect(row.status, `${row.id} wave ${row.wave} is not landed but is checked`).toBe("pending")
      expect(row.check, `${row.id} is pending but carries a check`).toBeUndefined()
    }
  })

  it("gives every live row a live id", () => {
    // given
    const liveRows = PARITY_ROWS.filter((row) => row.kind === "live")

    // when / then
    expect(liveRows.length, "the matrix lost all its live rows").toBeGreaterThan(0)
    for (const row of liveRows) {
      expect(typeof row.live, `${row.id} has no live id`).toBe("string")
      expect((row.live ?? "").length, `${row.id} has an empty live id`).toBeGreaterThan(0)
    }
  })
})
