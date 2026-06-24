import { Data, Effect } from "effect"
import Papa from "papaparse"
import { ALL_STAT_CANDIDATES, type ArmorPiece } from "../domain/model"

export class CsvParseError extends Data.TaggedError("CsvParseError")<{
  readonly message: string
}> {}

export class NoStatColumnsError extends Data.TaggedError("NoStatColumnsError")<{
  readonly headers: ReadonlyArray<string>
}> {}

export class NoArmorRowsError extends Data.TaggedError("NoArmorRowsError")<{}> {}

export interface ParsedArmor {
  readonly pieces: ReadonlyArray<ArmorPiece>
  /** Which stats we analyzed (clean names) — surfaced in the UI so detection is auditable. */
  readonly statColumns: ReadonlyArray<string>
  /** True if we found "(Base)" columns and used those for analysis. */
  readonly usedBaseStats: boolean
  /** Rows we couldn't fully parse (kept for transparency, not analyzed). */
  readonly skipped: number
}

type Row = Record<string, string>

// Build a lookup from a normalized (lowercased, trimmed) header to the real header key,
// so we're tolerant of casing/spacing differences across DIM versions.
const headerIndex = (headers: ReadonlyArray<string>): Map<string, string> => {
  const m = new Map<string, string>()
  for (const h of headers) m.set(h.trim().toLowerCase(), h)
  return m
}

const find = (idx: Map<string, string>, ...names: ReadonlyArray<string>): string | undefined => {
  for (const n of names) {
    const hit = idx.get(n.toLowerCase())
    if (hit) return hit
  }
  return undefined
}

const num = (v: string | undefined): number => {
  if (v == null) return 0
  const n = Number(v.trim())
  return Number.isFinite(n) ? n : 0
}

const bool = (v: string | undefined): boolean => (v ?? "").trim().toLowerCase() === "true"

export const parseArmorCsv = (csv: string): Effect.Effect<ParsedArmor, CsvParseError | NoStatColumnsError | NoArmorRowsError> =>
  Effect.gen(function* () {
    const result = Papa.parse<Row>(csv, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    })

    if (result.errors.length > 0) {
      // Papaparse reports per-row issues; surface the first as a representative error.
      const e = result.errors[0]
      yield* Effect.fail(new CsvParseError({ message: `${e.type}: ${e.message} (row ${e.row})` }))
    }

    const headers = result.meta.fields ?? []
    const idx = headerIndex(headers)

    // Detect stats: for each known stat name present, prefer its "(Base)" column so
    // dominance compares intrinsic rolls, not masterwork/mod-inflated live values.
    // Each entry maps a clean stat name (the model key) to the CSV column to read.
    let usedBaseStats = false
    const statDefs: Array<{ key: string; header: string }> = []
    for (const c of ALL_STAT_CANDIDATES) {
      if (!idx.has(c.toLowerCase())) continue
      const baseHeader = idx.get(`${c} (base)`.toLowerCase())
      if (baseHeader) usedBaseStats = true
      statDefs.push({ key: c, header: baseHeader ?? idx.get(c.toLowerCase())! })
    }
    if (statDefs.length === 0) {
      yield* Effect.fail(new NoStatColumnsError({ headers }))
    }
    const statColumns = statDefs.map((s) => s.key)

    const col = {
      name: find(idx, "Name"),
      id: find(idx, "Id"),
      hash: find(idx, "Hash"),
      klass: find(idx, "Equippable", "Equippable Class", "Class"),
      slot: find(idx, "Type"),
      // Rarity holds Exotic/Legendary; "Tier" is the numeric Armor 3.0 tier (0–5).
      rarity: find(idx, "Rarity", "Tier"),
      tier: find(idx, "Tier"),
      archetype: find(idx, "Archetype"),
      power: find(idx, "Power"),
      locked: find(idx, "Locked"),
      tag: find(idx, "Tag"),
      energy: find(idx, "Energy Capacity"),
      mwTier: find(idx, "Masterwork Tier"),
    }

    let skipped = 0
    const pieces: Array<ArmorPiece> = []
    result.data.forEach((row, i) => {
      const name = col.name ? row[col.name]?.trim() : ""
      const slot = col.slot ? row[col.slot]?.trim() : ""
      if (!name || !slot) {
        skipped++
        return
      }

      const stats: Record<string, number> = {}
      let total = 0
      for (const { key, header } of statDefs) {
        const v = num(row[header])
        stats[key] = v
        total += v
      }

      const energy = col.energy ? num(row[col.energy]) : 0
      const mwTier = col.mwTier ? num(row[col.mwTier]) : 0

      pieces.push({
        id: col.id ? row[col.id]?.trim() || `row-${i}` : `row-${i}`,
        hash: col.hash ? row[col.hash]?.trim() ?? "" : "",
        name,
        klass: col.klass ? row[col.klass]?.trim() || "Unknown" : "Unknown",
        slot,
        rarity: col.rarity ? row[col.rarity]?.trim() || "Unknown" : "Unknown",
        tier: col.tier ? num(row[col.tier]) : 0,
        archetype: col.archetype ? row[col.archetype]?.trim() ?? "" : "",
        power: col.power ? num(row[col.power]) : 0,
        stats,
        total,
        masterworked: energy >= 10 || mwTier >= 5,
        locked: col.locked ? bool(row[col.locked]) : false,
        tag: col.tag ? row[col.tag]?.trim() ?? "" : "",
      })
    })

    if (pieces.length === 0) {
      yield* Effect.fail(new NoArmorRowsError())
    }

    return { pieces, statColumns, usedBaseStats, skipped } satisfies ParsedArmor
  })
