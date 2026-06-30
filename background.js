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
// Share naming.js + sheet.js with the other contexts so the name keys and the sheet
// parser are ONE definition each, not copies kept in sync by hand. Chrome runs this as a
// service worker (importScripts available); Firefox loads them ahead of us via the
// background `scripts` array (manifest), where importScripts doesn't exist — hence the guard.
if (typeof importScripts === "function") importScripts("naming.js", "sheet.js");
const { normalizeName, WEAPON_TABS, tabUrl, buildFromTab } = globalThis.VaultAdvisor;

const CACHE_KEY = "tierCache3"; // bumped on shape/content change (barrel/mag; untiered entries)
const TTL_MS = 12 * 60 * 60 * 1000; // refetch at most twice a day

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
