/**
 * build-wishlist.js — the hosted-wishlist generator (Option B; see docs/adr/0002).
 *
 * Runs in Node (GitHub Actions), NOT in the extension. It reuses the SAME pure modules the
 * extension uses — sheet.js (CSV → entries) and wishlist.js (entries + manifest → DIM
 * wishlist text) — and only swaps the data sources: the sheet is fetched over HTTP, and the
 * manifest comes from the Bungie API instead of DIM's IndexedDB cache.
 *
 * Output: wishlists/<scope>.txt, committed by the workflow so users can subscribe to a raw
 * GitHub URL in DIM (Settings → Wish Lists). DIM honors one source at a time, so scope is
 * chosen by WHICH file, not by stacking subscriptions.
 *
 * Requires a Bungie API key in the BUNGIE_API_KEY env var (a free key from
 * https://www.bungie.net/en/Application; in CI it's the BUNGIE_API_KEY repo secret).
 * The `en` manifest is used deliberately — enhanced-perk detection is English-locale only.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { buildWishlist, buildLookups } = require("../wishlist.js");
const { WEAPON_TABS, tabUrl, buildFromTab } = require("../sheet.js");
const { normalizeName } = require("../naming.js");

const BUNGIE = "https://www.bungie.net";
const OUT_DIR = path.join(__dirname, "..", "wishlists");

// Curated scopes — `all` plus a few popular subsets. Not every tier combo (DIM takes one
// source); add a file here to publish another scope. Mode "full" = the complete recommended
// roll on one line, so DIM highlights barrel + mag too.
const SCOPES = [
  { file: "all.txt", tiers: [], label: "all tiers" },
  { file: "top.txt", tiers: ["S", "A"], label: "S + A (top tiers)" },
  { file: "S.txt", tiers: ["S"], label: "S tier" },
  { file: "A.txt", tiers: ["A"], label: "A tier" },
  { file: "B.txt", tiers: ["B"], label: "B tier" },
];
const MODE = "full";

async function fetchEntries() {
  const byName = new Map(); // normName -> entry (last wins, mirrors the extension's cache)
  await Promise.all(
    WEAPON_TABS.map(async (tab) => {
      const res = await fetch(tabUrl(tab));
      if (!res.ok) { console.warn(`sheet tab "${tab}": HTTP ${res.status} — skipped`); return; }
      for (const e of buildFromTab(tab, await res.text())) byName.set(normalizeName(e.name), e);
    }),
  );
  return [...byName.values()];
}

async function fetchManifestTables(apiKey) {
  const index = await fetch(`${BUNGIE}/Platform/Destiny2/Manifest/`, { headers: { "X-API-Key": apiKey } })
    .then((r) => r.json());
  if (!index.Response) throw new Error(`Bungie Manifest error: ${index.Message || index.ErrorStatus || "unknown"}`);
  const paths = index.Response.jsonWorldComponentContentPaths.en;
  const get = (p) => fetch(BUNGIE + p).then((r) => r.json());
  const [items, plugSets] = await Promise.all([
    get(paths.DestinyInventoryItemDefinition),
    get(paths.DestinyPlugSetDefinition),
  ]);
  return { items, plugSets };
}

async function main() {
  const apiKey = process.env.BUNGIE_API_KEY;
  if (!apiKey) { console.error("BUNGIE_API_KEY env var is required."); process.exit(1); }

  const entries = await fetchEntries();
  console.log(`Sheet: ${entries.length} weapons.`);
  const { items, plugSets } = await fetchManifestTables(apiKey);
  console.log(`Manifest: ${Object.keys(items).length} items, ${Object.keys(plugSets).length} plug sets.`);

  const lookups = buildLookups(items, plugSets);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const scope of SCOPES) {
    const want = new Set(scope.tiers);
    const scoped = want.size ? entries.filter((e) => want.has(e.tier)) : entries;
    const { text, stats } = buildWishlist(scoped, lookups, MODE);
    const banner = `// ${scope.label} — auto-generated from the Endgame Analysis tier sheet. Do not edit by hand.\n`;
    fs.writeFileSync(path.join(OUT_DIR, scope.file), banner + text);
    console.log(
      `${scope.file}: ${stats.weapons} weapons, ${stats.lines} rolls, ` +
      `${stats.unmatchedWeapons.length} unmatched weapons, ${stats.unmatchedPerks.length} unmatched perks.`,
    );
    if (stats.unmatchedPerks.length) console.log(`  unmatched perks: ${stats.unmatchedPerks.join(", ")}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
