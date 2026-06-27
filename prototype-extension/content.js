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
 * THE TIER FUNCTION IS A PLACEHOLDER. It uses real data (rarity, perks,
 * masterwork) but is NOT your real ranking. Swap `computeTier` for the logic in
 * src/domain/analysis.ts — everything around it (data + identify + inject) is the
 * part this prototype is proving.
 */
(() => {
  "use strict";
  const TAG = "[VA-BADGE]";
  const BADGE_ATTR = "data-va-badge";

  // Names we don't count as "perks" (shown in the tooltip, not used for the tier).
  const PERK_NAME_BLOCKLIST = [/shader/i, /empty .*socket/i, /masterwork/i, /^default ornament$/i, /tracker/i, /memento/i];

  // ---------------------------------------------------------------------------
  // TIER LIST — fetched live from the community sheet by the background worker
  // (see background.js) and cached. Tier is WEAPON-BOUND (keyed by weapon name)
  // and RELATIVE WITHIN each weapon category.
  // ---------------------------------------------------------------------------
  let tierMap = {}; // lowercased name -> { tier, rank, notes, category, perks }
  const TIER_COLOR = {
    S: "#f5b942", A: "#3fb950", B: "#58a6ff", C: "#d2a8ff",
    D: "#d29922", E: "#db6d28", F: "#f85149",
  };
  const UNKNOWN_COLOR = "#6e7681";

  function lookupTier(name) {
    const hit = tierMap[(name || "").trim().toLowerCase()];
    if (!hit) return { grade: "–", color: UNKNOWN_COLOR, known: false, notes: "Not in the tier list." };
    return {
      grade: hit.tier,
      color: TIER_COLOR[hit.tier] || UNKNOWN_COLOR,
      known: true,
      rank: hit.rank,
      notes: hit.notes,
      category: hit.category,
    };
  }

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

  // Assemble what the badge shows: weapon-bound tier + roll perks in the tooltip.
  function tierFor(item, def) {
    const name = def.displayProperties?.name || "";
    const t = lookupTier(name);
    const perks = perkNames(item.itemInstanceId);
    return {
      grade: t.grade,
      color: t.color,
      reasons: [
        t.known
          ? `${name} — Tier ${t.grade}${t.rank ? ` · Rank ${t.rank}` : ""}${t.category ? ` (${t.category})` : ""}`
          : `${name} — not in the tier list`,
        t.notes || "",
        perks.length ? `Your roll: ${perks.join(", ")}` : "",
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
      "box-shadow:0 1px 4px rgba(0,0,0,.5)",
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
          console.log(TAG, `Tier list: ${resp.count} weapons (${resp.cached ? "cached" : "fresh"}, ${resp.fetchedAt}).`);
          // Re-badge anything already open now that we have data.
          document.querySelectorAll(`[${BADGE_ATTR}]`).forEach((n) => n.remove());
          scanForPopup();
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

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (!msg) return;
    if (msg.type === "tierCounts") {
      respond({ ok: vault.ready, ready: vault.ready, counts: vault.ready ? tierCounts() : {} });
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

    const obs = new MutationObserver(() => scanForPopup());
    obs.observe(document.body, { childList: true, subtree: true });

    requestTiers();
    loadVault()
      .then(() => scanForPopup())
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
