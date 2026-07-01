/**
 * sheet.js — the community tier sheet, parsed.
 *
 * Pure CSV → entries: turns the Google-Sheets `gviz/tq?out:csv` text for one weapon tab
 * into entries `{ name, tier, rank, notes, category, perks:{ perk1, perk2, barrel, mag } }`
 * — the shape both the keep/shard engine and the wishlist generator consume.
 *
 * Shared by the extension's background service worker (which fetches + caches the sheet)
 * and the Node CI script that builds the hosted wishlist, so the column-detection and
 * row-parsing rules live in ONE place (see ADR-0001). No fetch, no chrome, no DOM — the
 * caller supplies the CSV text.
 *
 * Loaded as a background script (exposes globalThis.VaultAdvisor.*); CommonJS tail for node:test.
 */
(function (root) {
  "use strict";

  // theaegisrelic's community compendium. Tier is WEAPON-BOUND and RELATIVE WITHIN each
  // weapon category (an S-tier sniper ≠ an S-tier glaive).
  const SHEET_ID = "1JM-0SlxVDAi-C6rGVlLxa-J1WGewEeL8Qvq4htWZHhY";
  const WEAPON_TABS = [
    "Autos", "Bows", "HCs", "Pulses", "Scouts", "Sidearms", "SMGs", "BGLs",
    "Fusions", "Glaives", "Shotguns", "Snipers", "Rocket Sidearms", "Traces",
    "HGLs", "LFRs", "LMGs", "Rockets", "Swords", "Other", "Exotic Weapons",
  ];

  // The "Set Bonuses" tab on the SAME sheet — armor set grades, not weapons. Located by
  // gid because the tab name can be renamed; fetch-by-gid support is issue 02's job.
  const SET_BONUS_GID = "1665223292";

  const tabUrl = (tab) =>
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;

  // RFC-4180-ish CSV parser: handles quoted fields with embedded commas/newlines.
  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\r") { /* skip */ }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  const findCol = (headers, pred) => headers.findIndex((h) => pred(h.trim().toLowerCase()));

  // One tab's CSV → entries. Returns [] if the tab has no usable Name column.
  function buildFromTab(category, csv) {
    const rows = parseCSV(csv);
    if (!rows.length) return [];
    const h = rows[0];
    const iName = findCol(h, (s) => s === "name");
    const iTier = findCol(h, (s) => s === "tier");
    const iRank = findCol(h, (s) => s === "rank");
    const iNotes = findCol(h, (s) => s.includes("notes"));
    const iPerk1 = findCol(h, (s) => s.includes("perk 1"));
    const iPerk2 = findCol(h, (s) => s.includes("perk 2"));
    const iBarrel = findCol(h, (s) => s.includes("barrel"));
    // Exact-ish match so a "Damage"/"Image" header can't be mistaken for the magazine
    // column, while still accepting a "Magazine" header.
    const iMag = findCol(h, (s) => s === "mag" || s === "magazine");
    // A tab can list weapons with recommended perks but no Tier column at all (handled
    // per-row below). Only a missing Name column makes the tab unusable.
    if (iName < 0) return [];

    const cell = (row, i) => (i >= 0 ? (row[i] || "").trim() : "");
    const lines = (v) => v.split("\n").map((s) => s.trim()).filter(Boolean);

    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const name = cell(row, iName);
      if (!name) continue;
      const tier = cell(row, iTier);
      // recommended perks, used to rank duplicate copies (keep vs shard) and to wishlist
      const perks = {
        barrel: lines(cell(row, iBarrel)),
        mag: lines(cell(row, iMag)),
        perk1: lines(cell(row, iPerk1)),
        perk2: lines(cell(row, iPerk2)),
      };
      // Keep real entries: some tabs (e.g. "Other") list weapons with recommended perks
      // but no tier yet — still useful for keep-vs-shard and the wishlist.
      if (!tier && !perks.perk1.length && !perks.perk2.length) continue;
      out.push({ name, tier, rank: cell(row, iRank), notes: cell(row, iNotes), category, perks });
    }
    return out;
  }

  // The Set Bonuses tab → one entry PER SET (not per row). Different column shape from the
  // weapon tabs (no perk columns; a `Pcs` column), so it's a separate parser, not a reuse
  // of buildFromTab. Every set is two scattered rows — one Pcs=2, one Pcs=4 — grouped by
  // exact `Set` text (confirmed to match between a set's two rows). The two rows are
  // DIFFERENT bonuses with independent grades, so each set carries two.
  function buildSetBonusesFromTab(csv) {
    const rows = parseCSV(csv);
    if (!rows.length) return [];
    const h = rows[0];
    const iSet = findCol(h, (s) => s === "set");
    const iPcs = findCol(h, (s) => s === "pcs");
    const iBonus = findCol(h, (s) => s === "bonus");
    const iTier = findCol(h, (s) => s === "tier");
    const iRank = findCol(h, (s) => s === "rank");
    const iTrigger = findCol(h, (s) => s === "trigger");
    const iEffect = findCol(h, (s) => s === "effect");
    // "ANALYSIS Description" → notes, mirroring the weapon `notes` field.
    const iNotes = findCol(h, (s) => s.includes("description"));
    if (iSet < 0) return [];

    const cell = (row, i) => (i >= 0 ? (row[i] || "").trim() : "");

    // Map keyed on the set name preserves first-seen order across scattered rows.
    const bySet = new Map();
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const name = cell(row, iSet);
      if (!name) continue; // no set → nothing to group under
      const pcs = cell(row, iPcs);
      // Defensive: the sheet is confirmed 2-or-4 only. Anything else (empty, "3", typo) is
      // malformed — drop the row rather than crash or guess a slot.
      const slot = pcs === "2" ? "twoPc" : pcs === "4" ? "fourPc" : null;
      if (!slot) continue;
      let entry = bySet.get(name);
      if (!entry) {
        entry = { name, category: "Set Bonus", twoPc: null, fourPc: null };
        bySet.set(name, entry);
      }
      entry[slot] = {
        tier: cell(row, iTier),
        bonus: cell(row, iBonus),
        rank: cell(row, iRank),
        trigger: cell(row, iTrigger),
        effect: cell(row, iEffect),
        notes: cell(row, iNotes),
      };
    }
    return [...bySet.values()];
  }

  const api = { SHEET_ID, WEAPON_TABS, SET_BONUS_GID, tabUrl, parseCSV, buildFromTab, buildSetBonusesFromTab };
  root.VaultAdvisor = Object.assign(root.VaultAdvisor || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
