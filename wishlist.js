/**
 * wishlist.js — the pure sheet → DIM-wishlist generator.
 *
 * Turns the tier sheet's recommended rolls into DIM wishlist text, in the same shape the
 * hand-made community wishlist used: a `// <name>` + `//notes:Tier …` block per weapon,
 * then one `dimwishlist:item=<hash>&perks=<a>,<b>` line per accepted trait combo.
 *
 * Pure over two injected lookups, so it's testable without the multi-megabyte manifest:
 *   weaponHashes(normName) -> number[]   // every itemHash sharing this weapon name (reissues)
 *   plugHashes(perkName)   -> number[]   // every plug hash for this perk (base + enhanced)
 *
 * DIM matches a roll when ALL listed perks are present (AND), so "perk1 ∈ {A,B} and
 * perk2 ∈ {C,D}" expands to the cartesian product of the two trait columns — one line each.
 * Barrel/mag are deliberately NOT part of the match: they're secondary, and pinning a
 * specific one would make an otherwise-great roll miss the wishlist. The keep/shard engine
 * still uses them; the wishlist is just the "is this roll good" layer DIM highlights.
 *
 * Loaded as a content script after naming.js; CommonJS tail lets node:test require it.
 */
(function (root) {
  "use strict";

  const naming = (typeof require === "function" ? require("./naming.js") : root.VaultAdvisor) || {};
  const { normalizeName } = naming;

  // The `//notes:` line for one weapon — tier grade first (so `wishlistnotes:S` works in
  // DIM), then the sheet's free-text note collapsed to one line.
  function noteFor(e) {
    const bits = [e.tier ? `Tier ${e.tier}` : "Untiered"];
    if (e.notes) bits.push(String(e.notes).replace(/\s+/g, " ").trim());
    return bits.join(". ");
  }

  /**
   * buildWishlist(entries, { weaponHashes, plugHashes }) → { text, stats }
   *
   * entries: [{ name, tier, notes, perks: { perk1:[], perk2:[], barrel:[], mag:[] } }]
   *   — the tier sheet's rows. A row needs both trait columns to define a roll; rows
   *     without them are skipped (nothing to wishlist).
   * stats:   { weapons, lines, unmatchedWeapons:[name], unmatchedPerks:[name] } — what
   *   couldn't be resolved against the manifest, so the caller can surface coverage.
   */
  function buildWishlist(entries, lookups) {
    const weaponHashes = lookups.weaponHashes;
    const plugHashes = lookups.plugHashes;
    const out = ["// Vault Advisor — generated from the Endgame Analysis tier sheet"];
    const stats = { weapons: 0, lines: 0, unmatchedWeapons: [], unmatchedPerks: new Set() };

    for (const e of entries || []) {
      const p1 = (e.perks && e.perks.perk1) || [];
      const p2 = (e.perks && e.perks.perk2) || [];
      if (!p1.length || !p2.length) continue; // need both trait columns to define a roll

      const items = weaponHashes(normalizeName(e.name)) || [];
      if (!items.length) { stats.unmatchedWeapons.push(e.name); continue; }

      // Each trait column → the plug hashes for the perks the sheet accepts there.
      // A perk that resolves to no hash is recorded (unmatchedPerks) and dropped.
      const column = (names) => {
        const hs = [];
        for (const nm of names) {
          const found = plugHashes(nm) || [];
          if (found.length) hs.push(...found);
          else stats.unmatchedPerks.add(nm);
        }
        return [...new Set(hs)];
      };
      const c1 = column(p1);
      const c2 = column(p2);
      if (!c1.length || !c2.length) { stats.unmatchedWeapons.push(e.name); continue; }

      const seen = new Set();
      const lines = [];
      for (const h of items) {
        for (const a of c1) {
          for (const b of c2) {
            const line = `dimwishlist:item=${h}&perks=${a},${b}`;
            if (!seen.has(line)) { seen.add(line); lines.push(line); }
          }
        }
      }

      out.push("", `// ${e.name}`, `//notes:${noteFor(e)}`, ...lines);
      stats.weapons++;
      stats.lines += lines.length;
    }

    stats.unmatchedPerks = [...stats.unmatchedPerks];
    return { text: out.join("\n") + "\n", stats };
  }

  const api = { buildWishlist };
  root.VaultAdvisor = Object.assign(root.VaultAdvisor || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
