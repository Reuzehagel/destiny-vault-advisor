/**
 * Background service worker — fetches the community tier list and caches it.
 *
 * Why a background worker (not the content script): cross-origin fetches with the
 * extension's host permission (CORS-free) are only granted to extension contexts,
 * not content scripts. So we fetch here and hand the parsed map to the content
 * script over runtime messaging.
 *
 * Source: theaegisrelic's community compendium. Tier is WEAPON-BOUND and is
 * RELATIVE WITHIN each weapon category (an S-tier sniper ≠ an S-tier glaive).
 */
const SHEET_ID = "1JM-0SlxVDAi-C6rGVlLxa-J1WGewEeL8Qvq4htWZHhY";
const WEAPON_TABS = [
  "Autos", "Bows", "HCs", "Pulses", "Scouts", "Sidearms", "SMGs", "BGLs",
  "Fusions", "Glaives", "Shotguns", "Snipers", "Rocket Sidearms", "Traces",
  "HGLs", "LFRs", "LMGs", "Rockets", "Swords", "Other", "Exotic Weapons",
];
const CACHE_KEY = "tierCache3"; // bumped on shape/content change (barrel/mag; untiered entries)
const TTL_MS = 12 * 60 * 60 * 1000; // refetch at most twice a day

const tabUrl = (tab) =>
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;

// Canonical key for matching sheet names against in-game names. MUST stay identical
// to normalizeName() in content.js. Strips accents, unifies apostrophes, lowercases,
// collapses whitespace.
function normalizeName(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’‘`´]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

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
  const iMag = findCol(h, (s) => s === "mag");
  if (iName < 0 || iTier < 0) return [];

  const cell = (row, i) => (i >= 0 ? (row[i] || "").trim() : "");
  const lines = (v) => v.split("\n").map((s) => s.trim()).filter(Boolean);

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = cell(row, iName);
    if (!name) continue;
    const tier = cell(row, iTier);
    // recommended perks, used to rank duplicate copies (keep vs shard)
    const perks = {
      barrel: lines(cell(row, iBarrel)),
      mag: lines(cell(row, iMag)),
      perk1: lines(cell(row, iPerk1)),
      perk2: lines(cell(row, iPerk2)),
    };
    // Keep real entries: some tabs (e.g. "Other") list weapons with recommended
    // perks but no tier yet — still useful for keep-vs-shard.
    if (!tier && !perks.perk1.length && !perks.perk2.length) continue;
    out.push({ name, tier, rank: cell(row, iRank), notes: cell(row, iNotes), category, perks });
  }
  return out;
}

async function fetchAll() {
  const map = {};
  const perTab = {};
  await Promise.all(
    WEAPON_TABS.map(async (tab) => {
      try {
        const res = await fetch(tabUrl(tab), { credentials: "omit" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const entries = buildFromTab(tab, await res.text());
        perTab[tab] = entries.length;
        for (const e of entries) map[normalizeName(e.name)] = e; // last wins on dup names
      } catch (e) {
        perTab[tab] = "ERR " + (e && e.message ? e.message : e);
      }
    }),
  );
  return { map, perTab };
}

async function getTiers(force) {
  const now = Date.now();
  const stored = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY];

  if (!force && stored?.tiers && now - stored.ts < TTL_MS) {
    return ok(stored, true);
  }

  const { map, perTab } = await fetchAll();
  if (!Object.keys(map).length) {
    // Network hiccup — serve stale cache if we have any.
    if (stored?.tiers) return { ...ok(stored, true), stale: true };
    return { ok: false, error: "fetch returned no rows" };
  }
  const fresh = { ts: now, tiers: map, perTab };
  await chrome.storage.local.set({ [CACHE_KEY]: fresh });
  return ok(fresh, false);
}

function ok(entry, cached) {
  return {
    ok: true,
    cached,
    tiers: entry.tiers,
    perTab: entry.perTab,
    count: Object.keys(entry.tiers).length,
    fetchedAt: new Date(entry.ts).toISOString(),
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "getTiers") {
    getTiers(msg.force)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true; // keep the channel open for the async response
  }
});
