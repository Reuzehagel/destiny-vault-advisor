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

  const api = { normalizeName, looseName, perkKey, iconBase };
  root.VaultAdvisor = Object.assign(root.VaultAdvisor || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
