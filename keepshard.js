/**
 * keepshard.js — the pure keep/shard engine.
 *
 * Given the duplicate copies of ONE weapon and the sheet's recommended perks,
 * decide which copy to keep, which fills a gap (your call), and which to shard.
 * No globals, no DOM, no IndexedDB — plain perk NAMES in, structured verdict out.
 * See CONTEXT.md for the domain vocabulary (selectable / keeper / coverage / shard /
 * god roll) and .scratch/keepshard/PRD.md for the design.
 *
 * Loaded as a content script before content.js (exposes globalThis.VaultAdvisor);
 * the CommonJS tail lets node:test require it directly.
 */
(function (root) {
  "use strict";

  // perkKey (and the other name keys) live in naming.js — required directly in Node,
  // read off the shared global in the browser (naming.js loads first).
  const naming = (typeof require === "function" ? require("./naming.js") : root.VaultAdvisor) || {};
  const { perkKey } = naming;

  // What one copy presents against the recommendation. Pure over the copy's selectable
  // perks — never looks at what's currently socketed (switching is free).
  function matchCopy(selectable, rec) {
    const have = new Set((selectable || []).map(perkKey));
    // First recommended option in a column the copy can present → that option's sheet name.
    const hit = (col) =>
      (Array.isArray(col) ? col : []).map((p) => (have.has(perkKey(p)) ? p : null)).find(Boolean) || null;
    // How many distinct recommended options in a column the copy can switch between.
    const count = (col) => (Array.isArray(col) ? col : []).filter((p) => have.has(perkKey(p))).length;

    const matched = { perk1: hit(rec.perk1), perk2: hit(rec.perk2), barrel: hit(rec.barrel), mag: hit(rec.mag) };
    const hits = [matched.perk1, matched.perk2].filter(Boolean); // the god-roll traits
    const depth = count(rec.perk1) + count(rec.perk2) + count(rec.barrel) + count(rec.mag);

    // Every distinct recommended TRAIT (perk1/perk2) the copy can present, by sheet name.
    // Drives coverage — barrel/mag variety isn't worth a vault slot, so it's excluded.
    const traitKeys = new Set();
    const traitNames = [];
    for (const p of [...(rec.perk1 || []), ...(rec.perk2 || [])]) {
      const k = perkKey(p);
      if (have.has(k) && !traitKeys.has(k)) { traitKeys.add(k); traitNames.push(p); }
    }

    const perkScore = (matched.perk1 ? 1 : 0) + (matched.perk2 ? 1 : 0);
    const secScore = (matched.barrel ? 1 : 0) + (matched.mag ? 1 : 0);

    // A GOD ROLL is the PERFECT copy: it can present EVERY recommended option in each trait
    // column (all of perk1 AND all of perk2), plus at least one recommended barrel and mag.
    // Trait columns need the whole set; barrel/mag need just one. A column with no
    // recommendation is vacuously satisfied. Rare by design — the never-shard gold standard,
    // distinct from a plain keeper (just the best of your copies).
    const allOf = (col) => (Array.isArray(col) && col.length ? count(col) === col.length : true);
    const oneOf = (col) => (Array.isArray(col) && col.length ? count(col) >= 1 : true);
    const traitCols = [rec.perk1, rec.perk2].filter((c) => Array.isArray(c) && c.length);
    const godRoll = traitCols.length > 0 && traitCols.every(allOf) && oneOf(rec.barrel) && oneOf(rec.mag);

    return { matched, hits, depth, traitNames, perkScore, secScore, godRoll };
  }

  /**
   * rankGroup(copies, recommended, { keepCoverage }) → verdict | null
   *
   * copies:      [{ id, selectable: string[], masterwork: boolean, protected: boolean|string }]
   *              protected truthy → set aside; a string rides through as protectedReason.
   * recommended: { perk1, perk2, barrel, mag } — each an array of acceptable perk names
   *
   * Returns null when there's nothing to advise (singleton, no recommendation, or no
   * copy hits a recommended trait). Otherwise:
   *   { keepers: [id], total, copies: [{ id, role, hits, matched, depth, godRoll, unique?, protectedReason? }] }
   *   role ∈ "keeper" | "coverage" | "shard" | "protected"
   */
  function rankGroup(copies, recommended, options) {
    const keepCoverage = options ? options.keepCoverage !== false : true;
    const rec = recommended || {};
    if (!Array.isArray(copies)) return null;

    // Protected copies sit out of scoring entirely — never shard, never a keeper — but they
    // ARE still marked (the slate badge / 🔒 line). `protected` is opaque to the engine: any
    // truthy value sets the copy aside, and a string rides through as protectedReason.
    const protectedEntry = (c) => ({
      id: c.id, role: "protected", hits: [],
      matched: { perk1: null, perk2: null, barrel: null, mag: null },
      depth: 0, godRoll: false,
      protectedReason: typeof c.protected === "string" ? c.protected : null,
    });
    const protectedCopies = copies.filter((c) => c && c.protected);
    const active = copies.filter((c) => c && !c.protected);
    // When there's no keep/shard call to make (fewer than two active copies, or no active copy
    // hits a recommended trait), still surface any protected markers — going dark on the whole
    // group would hide a roll the user deliberately chose to protect.
    const protectedOnly = () =>
      protectedCopies.length ? { keepers: [], total: copies.length, copies: protectedCopies.map(protectedEntry) } : null;
    if (active.length < 2) return protectedOnly(); // need two comparable copies for a keep/shard call

    const scored = active.map((c) => {
      const m = matchCopy(c.selectable, rec);
      // Trait coverage dominates; then barrel/mag; then depth (capped so it can't outrank a
      // secondary column); then masterwork as the final nudge.
      const composite =
        m.perkScore * 1000 + m.secScore * 100 + Math.min(m.depth, 9) * 10 + (c.masterwork ? 1 : 0);
      return { c, m, composite };
    });

    const bestPerk = scored.reduce((mx, s) => Math.max(mx, s.m.perkScore), 0);
    if (bestPerk <= 0) return protectedOnly(); // no active copy hits a recommended trait → only protected markers

    // Keepers: every copy sharing the top composite (an exact tie keeps them all).
    const top = scored.reduce((mx, s) => Math.max(mx, s.composite), -1);
    const keeperIds = new Set(scored.filter((s) => s.composite === top).map((s) => s.c.id));

    // Coverage pass, greedy and best-first: a non-keeper that brings a recommended trait
    // not yet covered is yellow (your call); once a trait is covered, later copies with only
    // that trait add nothing → shard. Start from the keepers' combined trait coverage.
    const covered = new Set();
    for (const s of scored) if (keeperIds.has(s.c.id)) for (const n of s.m.traitNames) covered.add(perkKey(n));

    const roleById = new Map();
    const uniqueById = new Map();
    for (const s of [...scored].sort((a, b) => b.composite - a.composite)) {
      if (keeperIds.has(s.c.id)) { roleById.set(s.c.id, "keeper"); continue; }
      const adds = keepCoverage ? s.m.traitNames.filter((n) => !covered.has(perkKey(n))) : [];
      if (adds.length) {
        roleById.set(s.c.id, "coverage");
        uniqueById.set(s.c.id, adds);
        for (const n of adds) covered.add(perkKey(n));
      } else {
        roleById.set(s.c.id, "shard");
      }
    }

    const mByActive = new Map(scored.map((s) => [s.c.id, s.m]));
    const out = copies.map((c) => {
      if (c.protected) return protectedEntry(c);
      const m = mByActive.get(c.id);
      const e = { id: c.id, role: roleById.get(c.id), hits: m.hits, matched: m.matched, depth: m.depth, godRoll: m.godRoll };
      if (uniqueById.has(c.id)) e.unique = uniqueById.get(c.id);
      return e;
    });

    return {
      keepers: copies.filter((c) => keeperIds.has(c.id)).map((c) => c.id),
      total: copies.length,
      copies: out,
    };
  }

  const api = { rankGroup, matchCopy };
  root.VaultAdvisor = Object.assign(root.VaultAdvisor || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
