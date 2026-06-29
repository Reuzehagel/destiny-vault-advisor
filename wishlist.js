/**
 * wishlist.js — the pure sheet → DIM-wishlist generator.
 *
 * Turns the tier sheet's recommended rolls into DIM wishlist text, in the same shape the
 * hand-made community wishlist used: a `// <name>` + `//notes:Tier …` block per weapon,
 * then one `dimwishlist:item=<hash>&perks=<a>,<b>` line per accepted trait combo.
 *
 * Pure over two lookups derived from the manifest by buildLookups, so the generator is
 * testable without the multi-megabyte tables:
 *   weaponHashes(normName)   -> number[]              // weapon item hashes sharing this name
 *   weaponPlugs(weaponHash)  -> Map<perkKey, hash>    // the NON-enhanced perks THIS weapon rolls
 *
 * Why per-weapon (not a global name → hash map): DIM validates every cited perk hash against
 * the item and flags the bad ones ("perk does not appear on this item"). A perk NAME is
 * ambiguous in the manifest — "Demolitionist" is a weapon trait AND a ghost mod AND an armor
 * archetype AND an enhanced trait, each a different hash. So we resolve each weapon's own plug
 * sets and cite only hashes that weapon can actually roll, keeping the non-enhanced variant
 * (DIM normalizes enhanced itself and rejects enhanced hashes). Traits only (perk1 × perk2,
 * AND semantics); barrel/mag are left out so a great roll isn't missed for the wrong barrel.
 *
 * Loaded as a content script after naming.js; CommonJS tail lets node:test require it.
 */
(function (root) {
  "use strict";

  const naming = (typeof require === "function" ? require("./naming.js") : root.VaultAdvisor) || {};
  const { normalizeName, looseName, perkKey } = naming;

  /**
   * buildLookups(itemTable, plugSetTable) → { weaponHashes, weaponPlugs }
   *
   * Pure over the two DIM manifest tables (hash → def). The caller reads them from
   * IndexedDB (in-page) or the Bungie API (in CI); fixtures stand in for tests.
   *
   *   weaponHashes(normName) -> number[]            // every weapon (category 1) of this name
   *   weaponPlugs(weaponHash) -> Map<perkKey, hash> // non-enhanced perks the weapon can roll
   *
   * weaponHashes is permissive (every same-named weapon, incl. reissues/dummies) — that's safe
   * now because weaponPlugs gates validity: a weapon that can't roll a recommended perk simply
   * yields no line for it, instead of an invalid one.
   */
  function buildLookups(itemTable, plugSetTable) {
    const weapons = new Map(); // normName -> Set<weaponHash>
    const weaponsLoose = new Map(); // looseName -> Set<weaponHash> (punctuation/spacing fallback)
    const addName = (map, key, hash) => {
      let s = map.get(key);
      if (!s) map.set(key, (s = new Set()));
      s.add(hash);
    };
    for (const k in itemTable) {
      const def = itemTable[k];
      if (!def || def.redacted) continue;
      const name = def.displayProperties && def.displayProperties.name;
      if (!name || !(def.itemCategoryHashes || []).includes(1)) continue; // 1 = Weapon
      const hash = typeof def.hash === "number" ? def.hash : Number(k);
      if (!Number.isFinite(hash)) continue;
      addName(weapons, normalizeName(name), hash); // one normalize per name, not two
      addName(weaponsLoose, looseName(name), hash);
    }

    // Enhanced perks share the base NAME — only itemTypeDisplayName differs ("Enhanced Trait"
    // vs "Trait", "Enhanced Barrel" vs "Barrel"). DIM wants the non-enhanced hash.
    // LIMITATION: itemTypeDisplayName is localized, so this recognises enhanced perks only in
    // English-locale manifests (the primary user's, and the en-locale CI build). A non-English
    // DIM cache would need a locale-independent signal — tracked as a known gap.
    const isEnhanced = (d) => /^enhanced\b/i.test((d && d.itemTypeDisplayName) || "");
    const getDef = (table, h) => table[h] ?? table[String(h)];

    // Every plug a weapon can present, across its sockets' randomized + reusable plug sets and
    // any inline reusable plugs. currentlyCanRoll:false (retired options) are dropped.
    function candidateHashes(weaponDef) {
      const out = [];
      const fromSet = (setHash) => {
        const set = setHash ? getDef(plugSetTable, setHash) : null;
        for (const p of (set && set.reusablePlugItems) || []) {
          if (p && p.plugItemHash && p.currentlyCanRoll !== false) out.push(p.plugItemHash);
        }
      };
      for (const s of (weaponDef.sockets && weaponDef.sockets.socketEntries) || []) {
        fromSet(s.randomizedPlugSetHash);
        fromSet(s.reusablePlugSetHash);
        for (const p of s.reusablePlugItems || []) if (p && p.plugItemHash) out.push(p.plugItemHash);
      }
      return out;
    }

    const cache = new Map(); // weaponHash -> Map<perkKey, hash>
    function weaponPlugs(weaponHash) {
      let m = cache.get(weaponHash);
      if (m) return m;
      m = new Map();
      const def = getDef(itemTable, weaponHash);
      if (def) {
        for (const ph of candidateHashes(def)) {
          const pd = getDef(itemTable, ph);
          if (!pd || pd.redacted || !pd.plug || isEnhanced(pd)) continue; // non-enhanced, non-redacted perks only
          const nm = pd.displayProperties && pd.displayProperties.name;
          const key = nm && perkKey(nm);
          if (key && !m.has(key)) m.set(key, typeof pd.hash === "number" ? pd.hash : Number(ph));
        }
      }
      cache.set(weaponHash, m);
      return m;
    }

    // Exact normalized name first; fall back to the alphanumeric-only loose key (the same
    // fallback the advisor's tierLoose uses), so a sheet ↔ manifest punctuation/spacing drift
    // still resolves instead of silently dropping the weapon.
    const weaponHashes = (name) => {
      const exact = weapons.get(normalizeName(name));
      if (exact) return [...exact];
      const loose = weaponsLoose.get(looseName(name));
      return loose ? [...loose] : [];
    };
    return { weaponHashes, weaponPlugs };
  }

  // The `//notes:` line for one weapon — tier grade first (so `wishlistnotes:S` works in DIM),
  // then the sheet's free-text note collapsed to one line.
  function noteFor(e) {
    const bits = [e.tier ? `Tier ${e.tier}` : "Untiered"];
    if (e.notes) bits.push(String(e.notes).replace(/\s+/g, " ").trim());
    return bits.join(". ");
  }

  /**
   * buildWishlist(entries, { weaponHashes, weaponPlugs }, mode) → { text, stats }
   *
   * entries: [{ name, tier, notes, perks: { perk1:[], perk2:[], barrel:[], mag:[] } }] — sheet
   *   rows. A row needs both trait columns to define a roll; rows without them are skipped.
   * mode: how barrels/mags factor into the AND-matched line (default "full"):
   *   - "traits" — perk1 × perk2 only. Broadest: flags any roll with the recommended traits,
   *                but DIM won't highlight a barrel/mag (they're not in the line).
   *   - "full"   — perk1 × perk2 × barrel × mag: only the complete recommended roll matches,
   *                and DIM highlights all four. (A "secondary" mode that emitted separate
   *                barrel/mag lines was dropped: DIM highlights only the simplest matching
   *                roll, not the union, so those extra lines never lit up the barrel/mag.)
   * stats: { weapons, lines, unmatchedWeapons:[name], unmatchedPerks:[name] } — coverage:
   *   weapons whose name found no rollable copy, and TRAIT names that resolve on NO weapon at
   *   all (real sheet ↔ manifest name drift, not just a perk a given reissue lacks).
   */
  function buildWishlist(entries, lookups, mode) {
    mode = mode || "full";
    const { weaponHashes, weaponPlugs } = lookups;
    const out = ["// Vault Advisor — generated from the Endgame Analysis tier sheet"];
    const stats = { weapons: 0, lines: 0, unmatchedWeapons: [], unmatchedPerks: [] };
    const requested = new Map(); // trait perkKey -> a name that used it (for reporting)
    const resolved = new Set(); // perkKeys that resolved on at least one weapon

    for (const e of entries || []) {
      const p1 = (e.perks && e.perks.perk1) || [];
      const p2 = (e.perks && e.perks.perk2) || [];
      if (!p1.length || !p2.length) continue; // need both trait columns to define a roll
      const barrel = (e.perks && e.perks.barrel) || [];
      const mag = (e.perks && e.perks.mag) || [];

      const items = weaponHashes(e.name);
      if (!items.length) { stats.unmatchedWeapons.push(e.name); continue; }
      // Only count these traits as "requested" once the weapon NAME resolved — a weapon we
      // couldn't find isn't evidence its perk names drifted, so it must not pollute unmatchedPerks.
      for (const nm of [...p1, ...p2]) { const k = perkKey(nm); if (k && !requested.has(k)) requested.set(k, nm); }

      const seen = new Set();
      const lines = [];
      for (const h of items) {
        const plugs = weaponPlugs(h);
        if (!plugs.size) continue;
        // Each recommended NAME → this weapon's own hash for it (if it rolls it). Resolving a
        // trait marks it covered; barrel/mag keys aren't tracked for trait coverage.
        const resolve = (names) => {
          const hs = [];
          for (const nm of names) {
            const k = perkKey(nm);
            const hit = plugs.get(k);
            if (hit) { hs.push(hit); resolved.add(k); }
          }
          return [...new Set(hs)];
        };
        const c1 = resolve(p1), c2 = resolve(p2), cb = resolve(barrel), cm = resolve(mag);
        const emit = (perks) => {
          const line = `dimwishlist:item=${h}&perks=${perks.join(",")}`;
          if (!seen.has(line)) { seen.add(line); lines.push(line); }
        };
        for (const a of c1) {
          for (const b of c2) {
            if (a === b) continue; // a perk recommended in both columns can't fill both slots
            if (mode === "full") {
              // The complete roll in one line, so DIM highlights barrel/mag too. Missing
              // barrel/mag (sheet lists none, or the weapon can't roll it) drop out of the line.
              for (const bar of cb.length ? cb : [null]) {
                for (const mg of cm.length ? cm : [null]) emit([a, b, bar, mg].filter((x) => x != null));
              }
            } else {
              emit([a, b]); // traits only — broadest match, no barrel/mag highlight
            }
          }
        }
      }

      if (!lines.length) { stats.unmatchedWeapons.push(e.name); continue; }
      out.push("", `// ${e.name}`, `//notes:${noteFor(e)}`, ...lines);
      stats.weapons++;
      stats.lines += lines.length;
    }

    for (const [k, nm] of requested) if (!resolved.has(k)) stats.unmatchedPerks.push(nm);
    return { text: out.join("\n") + "\n", stats };
  }

  const api = { buildWishlist, buildLookups };
  root.VaultAdvisor = Object.assign(root.VaultAdvisor || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
