// Sanity-check the armor pipeline against the user's real DIM export.
// Run: pnpm dlx tsx scripts/check.ts
import { readFileSync } from "node:fs"
import { Effect } from "effect"
import { parseArmorCsv } from "../src/parse/dimArmor"
import { analyzeArmor } from "../src/domain/analysis"

const csv = readFileSync(new URL("../destiny-armor.csv", import.meta.url), "utf8")

const program = parseArmorCsv(csv).pipe(
  Effect.map((p) => ({ parsed: p, analysis: analyzeArmor(p.pieces, p.statColumns) })),
)

const { parsed, analysis } = await Effect.runPromise(program)

const rarities = new Map<string, number>()
for (const a of parsed.pieces) rarities.set(a.rarity, (rarities.get(a.rarity) ?? 0) + 1)

console.log("usedBaseStats:", parsed.usedBaseStats)
console.log("statColumns:", parsed.statColumns.join(", "))
console.log("pieces:", parsed.pieces.length, "skipped:", parsed.skipped)
console.log("rarity distribution:", Object.fromEntries(rarities))
console.log("summary:", analysis.summary)

const shard = analysis.armor.filter((a) => a.verdicts.includes("SHARD"))
console.log(`\nfirst 8 SHARD suggestions (of ${shard.length}):`)
for (const a of shard.slice(0, 8)) {
  console.log(`  ${a.klass} ${a.slot} "${a.name}" total=${a.total} dominatedBy=${a.dominatedBy.length}`)
}

const deimos = analysis.armor.filter((a) => a.name.includes("Deimosuffusion"))
console.log(`\nDeimosuffusion copies (${deimos.length}):`)
for (const a of deimos) {
  console.log(`  total=${a.total} stats=${parsed.statColumns.map((s) => a.stats[s]).join("/")} verdicts=[${a.verdicts.join(",")}]`)
}
console.log("\nstat order:", parsed.statColumns.join("/"))

const tagTally: Record<string, number> = {}
for (const p of parsed.pieces) tagTally[p.tag || "(none)"] = (tagTally[p.tag || "(none)"] ?? 0) + 1
console.log("tag distribution:", tagTally)
const lockedCount = parsed.pieces.filter((p) => p.locked).length
console.log("locked pieces:", lockedCount)
const verdictTally: Record<string, number> = {}
for (const a of analysis.armor) for (const v of a.verdicts) verdictTally[v] = (verdictTally[v] ?? 0) + 1
console.log("verdict tally (protect keep/favorite/archive):", verdictTally)

const noArchive = analyzeArmor(parsed.pieces, parsed.statColumns, ["keep", "favorite"])
console.log("shardable if archive NOT protected:", noArchive.summary.shardable, "dupes:", noArchive.summary.dupes)
