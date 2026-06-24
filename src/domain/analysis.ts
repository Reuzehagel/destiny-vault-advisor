import { deriveSet, isLegacyTier, type AnnotatedArmor, type ArmorPiece, type Verdict } from "./model"

export interface AnalysisSummary {
  readonly total: number
  readonly shardable: number
  readonly dupes: number
  /** Count of pre-Armor 3.0 (Tier 0) legacy pieces — the bulk of shard candidates. */
  readonly legacy: number
  readonly statColumns: ReadonlyArray<string>
}

export interface AnalysisResult {
  readonly armor: ReadonlyArray<AnnotatedArmor>
  readonly summary: AnalysisSummary
}

// Which DIM tags protect a piece from shard/dupe advice. In-game "locked" is never
// a signal here — many players lock reflexively, so it doesn't mean "keep".
export const DEFAULT_PROTECTED_TAGS: ReadonlyArray<string> = ["keep", "favorite", "archive"]

// q "covers" p when q is >= p on EVERY stat — there is no stat priority, and therefore no
// build, for which p is the better pick, so p is redundant. Tier-gates the comparison (a
// lower-tier piece never out-classes a higher one — more mod energy, and at T5 a tuning
// slot). Higher total breaks the >= tie; identical rolls fall back to a stable id tiebreak
// so exactly one of an identical pair survives. At T5 (flat 75 budget) covering collapses
// to an identical roll.
const covers = (q: ArmorPiece, p: ArmorPiece, statColumns: ReadonlyArray<string>): boolean => {
  if (q.id === p.id) return false
  if (q.tier < p.tier) return false
  for (const s of statColumns) {
    if ((q.stats[s] ?? 0) < (p.stats[s] ?? 0)) return false
  }
  return q.total > p.total || (q.total === p.total && q.id < p.id)
}

const groupBy = <T>(items: ReadonlyArray<T>, key: (t: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>()
  for (const it of items) {
    const k = key(it)
    const arr = m.get(k)
    if (arr) arr.push(it)
    else m.set(k, [it])
  }
  return m
}

// Exotic class items (Bond/Mark/Cloak) carry two RANDOM perk columns — their value is the
// perk *combination*, which the DIM CSV doesn't export. Identically-statted copies are not
// redundant (you want every perk combo), so they're excluded from dupe detection entirely.
const isClassItem = (p: ArmorPiece): boolean => /bond|mark|cloak|class item/i.test(p.slot)

export const analyzeArmor = (
  pieces: ReadonlyArray<ArmorPiece>,
  statColumns: ReadonlyArray<string>,
  protectedTags: ReadonlyArray<string> = DEFAULT_PROTECTED_TAGS,
): AnalysisResult => {
  const protectedSet = new Set(protectedTags.map((t) => t.toLowerCase()))
  const isProtected = (p: ArmorPiece): boolean => protectedSet.has(p.tag.toLowerCase())
  const isLegendary = (p: ArmorPiece): boolean => p.rarity.toLowerCase() === "legendary"

  // Duplicate detection. A piece is a DUPE only when another copy of the SAME item COVERS
  // it (>= on every stat). We only ever compare a piece against other copies of itself —
  // no cross-item, cross-set, or "interchangeable archetype" assumptions.
  //  • Exotics → grouped by name (fixed intrinsic). Class items are excluded (see above).
  //  • Legendary → grouped by name + archetype + tier, because an Armor 3.0 archetype fixes
  //    two stat spikes but the third can land in any column, so only same-archetype,
  //    same-tier copies are comparable. Legacy (T0) gear is handled by the SHARD pass below.
  const dupeIds = new Set<string>()
  const dominatedBy = new Map<string, string[]>()
  const flagDupes = (groups: Map<string, ArmorPiece[]>) => {
    for (const group of groups.values()) {
      if (group.length < 2) continue
      for (const p of group) {
        if (isProtected(p)) continue
        const coverers = group.filter((q) => covers(q, p, statColumns))
        if (coverers.length > 0) {
          dupeIds.add(p.id)
          dominatedBy.set(p.id, coverers.map((q) => q.id))
        }
      }
    }
  }
  flagDupes(
    groupBy(
      pieces.filter((p) => p.rarity.toLowerCase() === "exotic" && !isClassItem(p)),
      (p) => `${p.klass}|${p.name}`,
    ),
  )
  flagDupes(
    groupBy(
      pieces.filter((p) => isLegendary(p) && !isLegacyTier(p)),
      (p) => `${p.klass}|${p.name}|${p.archetype}|${p.tier}`,
    ),
  )

  const armor: AnnotatedArmor[] = pieces.map((p) => {
    const verdicts: Verdict[] = []
    const reasons: string[] = []
    const set = deriveSet(p)
    const legacy = isLegendary(p) && isLegacyTier(p)

    // Legacy (pre-3.0) legendary gear is obsolete under the tier system regardless of spread.
    if (legacy && !isProtected(p)) {
      verdicts.push("SHARD")
      reasons.push(
        `Legacy (pre–Armor 3.0) gear — Tier 0, can't be tuned or carry T4/T5 mod energy. Outclassed by the tier system; shard unless you keep it for transmog.`,
      )
    }
    if (dupeIds.has(p.id)) {
      verdicts.push("DUPE")
      reasons.push(
        `Another copy of ${p.name}${p.archetype ? ` (${p.archetype})` : ""} is ≥ it on every stat — a duplicate roll, so one can be removed.`,
      )
    }
    if (verdicts.length === 0 && isProtected(p)) {
      verdicts.push("KEEP")
      reasons.push(`Tagged "${p.tag}" in DIM.`)
    }

    return { ...p, verdicts, reasons, dominatedBy: dominatedBy.get(p.id) ?? [], set }
  })

  const summary: AnalysisSummary = {
    total: armor.length,
    shardable: armor.filter((a) => a.verdicts.includes("SHARD")).length,
    dupes: armor.filter((a) => a.verdicts.includes("DUPE")).length,
    legacy: armor.filter((a) => isLegendary(a) && isLegacyTier(a)).length,
    statColumns,
  }

  return { armor, summary }
}
