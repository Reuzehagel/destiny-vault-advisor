/**
 * naming.js — the one place names get normalized.
 *
 * Every "does this name match that name?" decision in the extension runs through
 * here: matching the community sheet's weapon names to in-game names, matching
 * recommended perk names to a roll's perks, and matching DIM's icon-only perk
 * circles by icon filename. These were copy-pasted across content.js, keepshard.js,
 * dimvault.js, and background.js — and normalizeName in particular carried a "MUST
 * stay identical to the other copy" comment, which is exactly the bug waiting to
 * happen that a shared module removes.
 *
 * Loaded first of the content scripts (so globalThis.VaultAdvisor.* is ready for the
 * others) and pulled into the service worker via importScripts. The CommonJS tail
 * lets node:test require it directly.
 */
(function (root) {
  "use strict";

  // Canonical key for matching sheet names against in-game names. Strips accents,
  // unifies the various apostrophe glyphs, lowercases, collapses whitespace. Used on
  // BOTH sides of every weapon-name comparison (sheet ↔ vault), so it must be one fn.
  function normalizeName(s) {
    return (s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[’‘`´]/g, "'")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  // Alphanumeric-only fallback key — matches when punctuation/spacing differs between
  // the sheet and in-game name (e.g. "Wish-Keeper" vs "Wish Keeper").
  const looseName = (s) => normalizeName(s).replace(/[^a-z0-9]/g, "");

  // Loose key for matching perk names across the sheet and the manifest: lowercase and
  // drop the "Enhanced" qualifier, so an enhanced perk circle still matches the sheet's
  // base-name recommendation.
  const perkKey = (s) =>
    (s || "").toLowerCase().replace(/\benhanced\b/g, " ").replace(/\s+/g, " ").trim();

  // The trailing filename of an icon path/URL (e.g. ".../icons/abc123.jpg" -> "abc123.jpg").
  const iconBase = (s) => {
    const path = (s || "").split("?")[0];
    return path.slice(path.lastIndexOf("/") + 1);
  };

  // --- Armor set-name matching ----------------------------------------------
  // The community sheet decorates each armor Set name with its SOURCE — "Exodus Down
  // Nessus", "TM Custom Spire of the Watcher" — while the manifest gives the CLEAN set
  // name ("Exodus Down", "Spire of the Watcher"). So the manifest name is a token-boundary
  // SUBSTRING of the sheet name (manifest ⊂ sheet). Weapon matching (exact normalizeName,
  // then equal-loose) can't hit here because the sheet string is a SUPERSET of the manifest
  // string, so set matching gets its own resolver.
  const setTokens = (s) => normalizeName(s).split(" ").filter(Boolean);

  // Is `needle` a contiguous run of WHOLE tokens inside `haystack`? Token-boundary so a
  // clean name matches only when all its words appear in order (the sheet prefixes/suffixes
  // the source, never splices it mid-word) — "oath" won't match "oathkeeper".
  function tokenSubsequence(needle, haystack) {
    if (!needle.length || needle.length > haystack.length) return false;
    outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
      for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  }

  // Build a resolver from a manifest's clean set name to its sheet entry.
  //   sheetSets     — the sheet's set map (normalizeName(decorated) -> entry), as
  //                   background.js keys it; each entry carries { name, twoPc, fourPc }.
  //   manifestNames — every owned set's clean name (from vault.setByInstance).
  //   aliases       — the small escape hatch (normalizeName(manifest) ->
  //                   normalizeName(sheet)) for the handful of names no rule can bridge,
  //                   supplied by the CALLER as policy (see CONTEXT.md's caller-owns-policy
  //                   seam) — not baked into this module.
  //
  // Each sheet entry is claimed by the LONGEST manifest name that is a token-subsequence of
  // it, so a short set name ("Iron") can't shadow a longer one ("Iron Will") that shares its
  // words. Returns { resolve(name) -> entry|null, misses, unmatchedSheet } — misses/​
  // unmatchedSheet mirror the weapon coverage report so drift is surfaced, never swallowed.
  function buildSetResolver(sheetSets, manifestNames, aliases) {
    const sets = sheetSets || {};
    const alias = aliases || {};
    const sheetEntries = Object.keys(sets).map((key) => ({ key, entry: sets[key], tokens: setTokens(key) }));
    const manifest = [...new Set((manifestNames || []).filter(Boolean))];

    const resolved = new Map(); // normalizeName(manifest) -> sheet entry
    const claimed = new Set(); // sheet keys taken by some manifest name

    for (const name of manifest) {
      const norm = normalizeName(name);
      // 1) Explicit alias wins outright — the caller's override for irreducible names.
      const aliasKey = alias[norm];
      if (aliasKey && sets[aliasKey]) {
        resolved.set(norm, sets[aliasKey]);
        claimed.add(aliasKey);
        continue;
      }
      // 2) Token-subsequence match. Skip any sheet entry a LONGER owned name also fits
      //    (shadow guard); among what's left, prefer the shortest sheet name — closest to a
      //    clean, undecorated match.
      const nameTokens = setTokens(name);
      let best = null;
      for (const s of sheetEntries) {
        if (!tokenSubsequence(nameTokens, s.tokens)) continue;
        const shadowed = manifest.some((other) => {
          if (other === name) return false;
          const ot = setTokens(other);
          return ot.length > nameTokens.length && tokenSubsequence(ot, s.tokens);
        });
        if (shadowed) continue;
        if (!best || s.tokens.length < best.tokens.length) best = s;
      }
      if (best) {
        resolved.set(norm, best.entry);
        claimed.add(best.key);
      }
    }

    const misses = manifest.filter((n) => !resolved.has(normalizeName(n)));
    const unmatchedSheet = sheetEntries.filter((s) => !claimed.has(s.key)).map((s) => s.entry.name || s.key);

    return {
      resolve: (name) => resolved.get(normalizeName(name)) || null,
      misses,
      unmatchedSheet,
    };
  }

  const api = { normalizeName, looseName, perkKey, iconBase, buildSetResolver };
  root.VaultAdvisor = Object.assign(root.VaultAdvisor || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
