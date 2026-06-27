/**
 * Vault Advisor — Tier Badge (prototype)
 *
 * Proves the full in-page loop:
 *   click a weapon in DIM  ->  identify the exact instance  ->  look it up in the
 *   vault data cached in IndexedDB  ->  compute a tier  ->  draw a badge in the
 *   item popup's top-right.
 *
 * No OAuth, no API key, no DOM scraping for data — the data comes from DIM's own
 * `keyval-store` IndexedDB (see the sibling spike for the proof of that).
 *
 * HOW IT KNOWS WHICH ITEM:
 *   - DIM renders every item tile as <div id="{itemInstanceId}" class="item ...">
 *     (InventoryItem.tsx; createItemIndex() returns item.id == instanceId for
 *     instanced gear). We capture clicks on `.item` and remember the id.
 *   - The popup is <div class="item-popup" role="dialog"> (ItemPopup.tsx) — a
 *     plain, non-hashed class. We watch for it and inject into its header.
 *
 * Tiers come from the community sheet (weapon-bound). On top of that:
 *   - Tier search (toolbar popup): filter DIM to owned weapons in chosen tiers.
 *   - Redundant rolls: when you own several copies of a weapon, the copies whose
 *     perks are worse than your best copy (vs. the sheet's recommended perks) get
 *     outlined as shard candidates.
 */
(() => {
  "use strict";
  const TAG = "[VA-BADGE]";
  const BADGE_ATTR = "data-va-badge";
  const SHARD_ATTR = "data-va-shard";
  const STATE_LOCKED = 1; // Bungie item.state bitflag

  // Names we don't count as "perks" (shown in the tooltip, not used for the tier).
  const PERK_NAME_BLOCKLIST = [/shader/i, /empty .*socket/i, /masterwork/i, /^default ornament$/i, /tracker/i, /memento/i];

  // ---------------------------------------------------------------------------
  // TIER LIST — fetched live from the community sheet by the background worker
  // (see background.js) and cached. Tier is WEAPON-BOUND (keyed by weapon name)
  // and RELATIVE WITHIN each weapon category.
  // ---------------------------------------------------------------------------
  let tierMap = {}; // normalized name -> entry
  let tierLoose = {}; // alphanumeric-only name -> entry (fallback when exact misses)
  const TIER_COLOR = {
    S: "#f5b942", A: "#3fb950", B: "#58a6ff", C: "#d2a8ff",
    D: "#d29922", E: "#db6d28", F: "#f85149",
  };
  const UNKNOWN_COLOR = "#6e7681";

  // MUST stay identical to normalizeName() in background.js.
  function normalizeName(s) {
    return (s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[’‘`´]/g, "'")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }
  const looseName = (s) => normalizeName(s).replace(/[^a-z0-9]/g, "");

  function rebuildLooseIndex() {
    tierLoose = {};
    for (const e of Object.values(tierMap)) {
      const k = looseName(e.name);
      if (k && !(k in tierLoose)) tierLoose[k] = e;
    }
  }

  function lookupTier(name) {
    const hit = tierMap[normalizeName(name)] || tierLoose[looseName(name)];
    if (!hit) return { grade: "–", color: UNKNOWN_COLOR, known: false, notes: "Not in the tier list." };
    return {
      grade: hit.tier,
      color: TIER_COLOR[hit.tier] || UNKNOWN_COLOR,
      known: true,
      rank: hit.rank,
      notes: hit.notes,
      category: hit.category,
      perks: hit.perks,
    };
  }

  // Redundant-roll state. redundant: instanceId -> { name, score, best }.
  let highlightOn = false;
  let redundant = new Map();
  let excludeExotics = false;
  const isExotic = (def) => def?.inventory?.tierType === 6;

  /** In-memory index built once from IndexedDB. */
  const vault = {
    ready: false,
    error: null,
    /** instanceId -> { item, hash } */
    byInstance: new Map(),
    /** hash -> trimmed InventoryItem def (only owned + plug hashes) */
    defs: new Map(),
    /** instanceId -> [plugHash, ...] (visible, enabled sockets) */
    socketsByInstance: new Map(),
  };

  let lastClickedInstanceId = null;

  // --- IndexedDB helpers ----------------------------------------------------
  const openDB = (name) =>
    new Promise((resolve, reject) => {
      let existed = true;
      const req = indexedDB.open(name);
      req.onupgradeneeded = () => (existed = false);
      req.onsuccess = () => resolve({ db: req.result, existed });
      req.onerror = () => reject(req.error);
    });
  const idbGet = (db, store, key) =>
    new Promise((resolve, reject) => {
      const r = db.transaction(store, "readonly").objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  const idbAllKeys = (db, store) =>
    new Promise((resolve, reject) => {
      const r = db.transaction(store, "readonly").objectStore(store).getAllKeys();
      r.onsuccess = () => resolve(r.result.map(String));
      r.onerror = () => reject(r.error);
    });

  // --- Load vault + manifest once -------------------------------------------
  async function loadVault() {
    const { db, existed } = await openDB("keyval-store");
    if (!existed) {
      indexedDB.deleteDatabase("keyval-store");
      throw new Error("DIM cache not found — sign into DIM and let inventory load, then reload.");
    }
    const keys = await idbAllKeys(db, "keyval");
    const profileKeys = keys.filter((k) => k.startsWith("profile-"));
    if (!profileKeys.length) throw new Error("No cached profile — let DIM finish loading once.");

    // Gather every instanced item + its sockets, and the hashes we'll need to resolve.
    const neededHashes = new Set();
    for (const pk of profileKeys) {
      const profile = await idbGet(db, "keyval", pk);
      if (!profile) continue;
      const socketData = profile.itemComponents?.sockets?.data || {};
      const buckets = [
        profile.profileInventory?.data?.items,
        ...Object.values(profile.characterInventories?.data || {}).map((c) => c.items),
        ...Object.values(profile.characterEquipment?.data || {}).map((c) => c.items),
      ];
      for (const items of buckets) {
        for (const item of items || []) {
          if (!item.itemInstanceId) continue;
          vault.byInstance.set(item.itemInstanceId, item);
          neededHashes.add(item.itemHash);
          const sockets = (socketData[item.itemInstanceId]?.sockets || [])
            .filter((s) => s.isVisible && s.isEnabled && s.plugHash)
            .map((s) => s.plugHash);
          vault.socketsByInstance.set(item.itemInstanceId, sockets);
          for (const h of sockets) neededHashes.add(h);
        }
      }
    }

    // Read the (big) InventoryItem table once, keep only the defs we need, drop the rest.
    const itemDefKey = keys.find((k) => /^d2-manifest-InventoryItem$/.test(k)) || keys.find((k) => /InventoryItem/.test(k));
    if (!itemDefKey) throw new Error("InventoryItem manifest table not cached yet.");
    const bigTable = await idbGet(db, "keyval", itemDefKey);
    for (const h of neededHashes) {
      const def = bigTable[h] ?? bigTable[String(h)];
      if (def) vault.defs.set(h, def);
    }
    db.close();

    vault.ready = true;
    console.log(TAG, `Vault loaded: ${vault.byInstance.size} instances, ${vault.defs.size} defs.`);
  }

  // The perks on the held roll — shown in the tooltip as context, NOT used to pick
  // the tier (tier is weapon-bound). Useful later for "is this a god roll?" matching.
  function perkNames(instanceId) {
    const plugs = vault.socketsByInstance.get(instanceId) || [];
    return plugs
      .map((h) => vault.defs.get(h)?.displayProperties?.name)
      .filter(Boolean)
      .filter((n) => !PERK_NAME_BLOCKLIST.some((re) => re.test(n)));
  }

  // The sheet's recommended perks for a weapon, flattened to a display string.
  function recommendedPerks(t) {
    if (!t.perks) return "";
    const cols = [t.perks.perk1, t.perks.perk2].filter((c) => c && c.length);
    return cols.map((c) => c.join("/")).join(" + ");
  }

  // Assemble what the badge shows: weapon-bound tier + recommended/your perks + dupe note.
  function tierFor(item, def) {
    const name = def.displayProperties?.name || "";
    const t = lookupTier(name);
    const perks = perkNames(item.itemInstanceId);
    const rec = recommendedPerks(t);
    const dupe = redundant.get(item.itemInstanceId);
    return {
      grade: t.grade,
      color: t.color,
      redundant: Boolean(dupe),
      reasons: [
        t.known
          ? `${name} — Tier ${t.grade}${t.rank ? ` · Rank ${t.rank}` : ""}${t.category ? ` (${t.category})` : ""}`
          : `${name} — not in the tier list`,
        t.notes || "",
        rec ? `Want: ${rec}` : "",
        perks.length ? `Your roll: ${perks.join(", ")}` : "",
        dupe ? "⚠ Redundant — you own a better-rolled copy." : "",
      ].filter(Boolean),
    };
  }

  // --- Badge injection ------------------------------------------------------
  function makeBadge(tier) {
    const el = document.createElement("div");
    el.setAttribute(BADGE_ATTR, "1");
    el.title = tier.reasons.join("\n");
    el.textContent = tier.grade;
    el.style.cssText = [
      "position:absolute",
      "top:8px",
      "right:10px",
      "z-index:5",
      "width:26px",
      "height:26px",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "border-radius:6px",
      "font:700 15px/1 ui-monospace,Menlo,Consolas,monospace",
      "color:#0b0d10",
      `background:${tier.color}`,
      tier.redundant ? "box-shadow:0 0 0 2px #f85149,0 1px 4px rgba(0,0,0,.5)" : "box-shadow:0 1px 4px rgba(0,0,0,.5)",
      "cursor:default",
      "pointer-events:auto",
    ].join(";");
    return el;
  }

  function injectInto(popup) {
    if (popup.querySelector(`[${BADGE_ATTR}]`)) return; // already badged

    // Header anchor: the title <h1> lives inside the header <button>. Fall back to
    // the popup root if structure changes.
    const titleEl = popup.querySelector("h1");
    const header = (titleEl && titleEl.closest("button")) || popup.firstElementChild || popup;

    if (!lastClickedInstanceId) {
      console.log(TAG, "Popup opened but no clicked instance recorded — skipping.");
      return;
    }
    const item = vault.byInstance.get(lastClickedInstanceId);
    if (!item) {
      console.log(TAG, `No vault data for instance ${lastClickedInstanceId} (non-instanced or stale cache).`);
      return;
    }
    const def = vault.defs.get(item.itemHash);
    if (!def) return;

    const tier = tierFor(item, def);
    const cs = getComputedStyle(header);
    if (cs.position === "static") header.style.position = "relative";
    header.appendChild(makeBadge(tier));
    console.log(TAG, `Badged "${def.displayProperties?.name}" -> ${tier.grade}`);
  }

  function scanForPopup() {
    if (!vault.ready) return;
    for (const popup of document.querySelectorAll(".item-popup")) injectInto(popup);
  }

  // Pull the live tier list from the background worker (which fetches the sheet).
  function requestTiers() {
    try {
      chrome.runtime.sendMessage({ type: "getTiers" }, (resp) => {
        if (chrome.runtime.lastError) {
          console.warn(TAG, "tier fetch messaging failed:", chrome.runtime.lastError.message);
          return;
        }
        if (resp?.ok) {
          tierMap = resp.tiers || {};
          rebuildLooseIndex();
          console.log(TAG, `Tier list: ${resp.count} weapons (${resp.cached ? "cached" : "fresh"}, ${resp.fetchedAt}).`);
          // Re-badge anything already open now that we have data.
          document.querySelectorAll(`[${BADGE_ATTR}]`).forEach((n) => n.remove());
          computeRedundant();
          scanForPopup();
          applyHighlights();
        } else {
          console.warn(TAG, "tier fetch failed:", resp?.error);
        }
      });
    } catch (e) {
      console.warn(TAG, "no background messaging available:", e.message);
    }
  }

  // --- Tier search (driven by the toolbar popup) ----------------------------
  // Every owned weapon we can tier, as { name, grade }.
  function ownedTiered() {
    const out = [];
    for (const [, item] of vault.byInstance) {
      const def = vault.defs.get(item.itemHash);
      const name = def?.displayProperties?.name;
      if (!name) continue;
      if (excludeExotics && isExotic(def)) continue;
      const t = lookupTier(name);
      if (t.known) out.push({ name, grade: t.grade });
    }
    return out;
  }

  function tierCounts() {
    const counts = {};
    for (const { grade } of ownedTiered()) counts[grade] = (counts[grade] || 0) + 1;
    return counts;
  }

  // How many of your owned weapons matched the tier list, and which didn't.
  function coverage() {
    const seen = new Set();
    const unmatched = new Set();
    let matched = 0;
    for (const [, item] of vault.byInstance) {
      const def = vault.defs.get(item.itemHash);
      if (!def || !(def.itemCategoryHashes || []).includes(1)) continue; // weapons only
      if (excludeExotics && isExotic(def)) continue;
      const name = def.displayProperties?.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      if (lookupTier(name).known) matched++;
      else unmatched.add(name);
    }
    return { ownedWeapons: seen.size, matched, unmatched: [...unmatched].sort() };
  }

  // Build a DIM search matching owned weapons in the selected tiers.
  function buildTierQuery(grades) {
    const want = new Set(grades);
    const names = new Set();
    for (const { name, grade } of ownedTiered()) if (want.has(grade)) names.add(name);
    const list = [...names];
    const query = list.length
      ? "(" + list.map((n) => `name:"${n.replace(/"/g, "")}"`).join(" or ") + ")"
      : "";
    return { query, count: list.length };
  }

  function setDimSearch(query) {
    const inputs = [...document.querySelectorAll(".search-filter input")];
    const input = inputs.find((i) => i.offsetParent !== null) || inputs[0];
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.focus();
    return true;
  }

  // --- Redundant duplicate rolls --------------------------------------------
  // Score a copy by how many of the sheet's recommended perks it actually has.
  function rollScore(instanceId, recPerks) {
    if (!recPerks) return 0;
    const have = new Set(perkNames(instanceId).map((n) => n.toLowerCase()));
    const desired = [...(recPerks.perk1 || []), ...(recPerks.perk2 || [])].map((s) => s.toLowerCase());
    let n = 0;
    for (const d of desired) if (have.has(d)) n++;
    return n;
  }

  // Within each set of duplicate weapons, flag copies worse than your best copy.
  function computeRedundant() {
    redundant = new Map();
    if (!vault.ready || !Object.keys(tierMap).length) return;

    const groups = new Map(); // itemHash -> [{ id, item }]
    for (const [id, item] of vault.byInstance) {
      if (!vault.defs.get(item.itemHash)) continue;
      if (!groups.has(item.itemHash)) groups.set(item.itemHash, []);
      groups.get(item.itemHash).push({ id, item });
    }

    for (const [hash, copies] of groups) {
      if (copies.length < 2) continue;
      const def = vault.defs.get(hash);
      if (excludeExotics && isExotic(def)) continue;
      const rec = tierMap[(def.displayProperties?.name || "").toLowerCase()]?.perks;
      if (!rec) continue; // need recommended perks to judge "the roll you want"

      const scored = copies.map((c) => ({
        ...c,
        score: rollScore(c.id, rec),
        locked: ((c.item.state || 0) & STATE_LOCKED) !== 0,
      }));
      const best = Math.max(...scored.map((s) => s.score));
      if (best <= 0) continue; // no copy has the wanted roll — nothing to flag

      for (const s of scored) {
        if (s.score < best && !s.locked) {
          redundant.set(s.id, { name: def.displayProperties?.name, score: s.score, best });
        }
      }
    }
    console.log(TAG, `Redundant rolls: ${redundant.size} shard candidates.`);
  }

  function markTile(tile) {
    tile.setAttribute(SHARD_ATTR, "1");
    tile.style.outline = "2px solid #f85149";
    tile.style.outlineOffset = "-2px";
    tile.style.borderRadius = "4px";
  }
  function clearTile(tile) {
    tile.removeAttribute(SHARD_ATTR);
    tile.style.outline = "";
    tile.style.outlineOffset = "";
  }
  function applyHighlights() {
    if (!highlightOn) {
      document.querySelectorAll(`[${SHARD_ATTR}]`).forEach(clearTile);
      return;
    }
    // Clear outlines that are no longer redundant (e.g. after toggling exotics).
    document.querySelectorAll(`[${SHARD_ATTR}]`).forEach((tile) => {
      if (!redundant.has(tile.id)) clearTile(tile);
    });
    for (const id of redundant.keys()) {
      const tile = document.getElementById(id);
      if (tile && !tile.hasAttribute(SHARD_ATTR)) markTile(tile);
    }
  }

  function setExclude(on) {
    on = Boolean(on);
    if (on === excludeExotics) return;
    excludeExotics = on;
    computeRedundant();
    applyHighlights();
  }

  // DIM search for the weapons that have a shardable copy (all copies match by
  // name; the worse ones are the outlined tiles within that filtered view).
  function buildRedundantQuery() {
    const names = new Set();
    for (const r of redundant.values()) names.add(r.name);
    const list = [...names];
    const query = list.length
      ? "(" + list.map((n) => `name:"${n.replace(/"/g, "")}"`).join(" or ") + ")"
      : "";
    return { query, weapons: list.length, instances: redundant.size };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (!msg) return;
    if ("excludeExotics" in msg) setExclude(msg.excludeExotics); // sync with popup

    if (msg.type === "tierCounts") {
      respond({
        ok: vault.ready,
        ready: vault.ready,
        counts: vault.ready ? tierCounts() : {},
        coverage: vault.ready ? coverage() : null,
        redundant: redundant.size,
        highlightOn,
        excludeExotics,
      });
      return;
    }
    if (msg.type === "highlightRedundant") {
      highlightOn = Boolean(msg.on);
      applyHighlights();
      respond({ ok: true, redundant: redundant.size, highlightOn });
      return;
    }
    if (msg.type === "tierSearch") {
      if (!vault.ready) {
        respond({ ok: false, error: "vault not loaded yet" });
        return;
      }
      const { query, count } = buildTierQuery(msg.tiers || []);
      const applied = msg.apply ? setDimSearch(query) : false;
      respond({ ok: true, count, query, applied });
      return;
    }
    if (msg.type === "redundantSearch") {
      const { query, weapons, instances } = buildRedundantQuery();
      let applied = false;
      if (msg.apply && query) {
        applied = setDimSearch(query);
        highlightOn = true; // outline the worse copies within the filtered view
        applyHighlights();
      }
      respond({ ok: true, query, weapons, instances, applied, highlightOn });
      return;
    }
  });

  // --- Wire up --------------------------------------------------------------
  function start() {
    // Remember which instance was clicked (capture phase, before DIM stops it).
    document.addEventListener(
      "click",
      (e) => {
        const tile = e.target.closest && e.target.closest(".item");
        if (tile && tile.id) lastClickedInstanceId = tile.id;
      },
      true,
    );

    const obs = new MutationObserver(() => {
      scanForPopup();
      applyHighlights(); // re-apply as DIM re-renders tiles (scroll, filter, etc.)
    });
    obs.observe(document.body, { childList: true, subtree: true });

    requestTiers();
    loadVault()
      .then(() => {
        computeRedundant();
        scanForPopup();
        applyHighlights();
      })
      .catch((e) => {
        vault.error = e;
        console.warn(TAG, e.message || e);
      });

    console.log(TAG, "active — click a weapon in DIM.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
