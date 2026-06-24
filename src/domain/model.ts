// Normalized domain model for armor, independent of DIM's exact CSV column names.

/** A piece's stats, keyed by the stat name DIM exported (e.g. "Resilience" or "Health"). */
export type Stats = Record<string, number>

export type Rarity = "Exotic" | "Legendary" | "Rare" | "Uncommon" | "Common" | string

export interface ArmorPiece {
  /** DIM "Id" — stable per-instance id, used as React key and for dominance comparisons. */
  readonly id: string
  /** DIM "Hash" — the item definition hash; maps to the Bungie manifest (for icons). */
  readonly hash: string
  readonly name: string
  /** DIM "Equippable" — the class that can use it (Hunter / Titan / Warlock). */
  readonly klass: string
  /** DIM "Type" — the armor slot bucket (Helmet, Gauntlets, Chest Armor, Leg Armor, class item). */
  readonly slot: string
  readonly rarity: Rarity
  /** Armor 3.0 tier (0–5); 0 for legacy/pre-3.0 armor. */
  readonly tier: number
  /** Armor 3.0 archetype (e.g. "Grenadier", "Bulwark"); "" if absent. */
  readonly archetype: string
  readonly power: number
  /** Exported stat values, keyed by stat name (base stats when available). */
  readonly stats: Stats
  /** Sum of all detected stat values. */
  readonly total: number
  readonly masterworked: boolean
  readonly locked: boolean
  readonly tag: string // DIM tag: keep / junk / infuse / favorite / archive / ""
}

/** Advisor verdicts attached to a piece after analysis. */
export type Verdict = "SHARD" | "DUPE" | "KEEP"

export interface AnnotatedArmor extends ArmorPiece {
  readonly verdicts: ReadonlyArray<Verdict>
  /** Human-readable reasons, aligned 1:1 with verdicts. */
  readonly reasons: ReadonlyArray<string>
  /** If a duplicate, the ids of the other copies of this item that cover it (≥ on every stat). */
  readonly dominatedBy: ReadonlyArray<string>
  /** Derived armor-set family (e.g. "Disaster Corps"); "" for exotics / unknowable. */
  readonly set: string
}

/**
 * Derive the armor-set family from an item name. Armor 3.0 sets are named families
 * ("Disaster Corps Vestment", "Disaster Corps Bond" → "Disaster Corps"), so we drop the
 * trailing slot word. Heuristic, name-based — only meaningful for legendary set armor.
 */
export const deriveSet = (p: ArmorPiece): string => {
  if (p.rarity.toLowerCase() !== "legendary") return ""
  const words = p.name.trim().split(/\s+/)
  return words.length > 1 ? words.slice(0, -1).join(" ") : p.name
}

// Candidate stat-column names across Destiny eras. The parser keeps whichever
// of these appear in the CSV header, so a future rename only needs an entry here.
export const LEGACY_STATS = [
  "Mobility",
  "Resilience",
  "Recovery",
  "Discipline",
  "Intellect",
  "Strength",
] as const

// Post-2025 "Armor 3.0" (Edge of Fate) stat names, in the in-game display order.
export const ARMOR3_STATS = ["Health", "Melee", "Grenade", "Super", "Class", "Weapons"] as const

/**
 * Armor 3.0 gear tier (DIM "Tier" column, 0–5). Tier is the stat *budget*: T5 is a fixed
 * 75 total (30/25/20) with a tuning slot, while legacy pre-3.0 armor exports as tier 0.
 * Tier 0 means "pre-Armor 3.0" — it can't be tuned or earn the extra mod energy of T4/T5,
 * so it's effectively obsolete regardless of its raw stat spread.
 */
export const LEGACY_TIER = 0
export const isLegacyTier = (p: ArmorPiece): boolean => p.tier <= LEGACY_TIER

export const ALL_STAT_CANDIDATES: ReadonlyArray<string> = [...LEGACY_STATS, ...ARMOR3_STATS]
