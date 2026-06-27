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
  const STATE_MASTERWORK = 4; // Bungie item.state bitflag
  const BUILD = "perks-v4"; // bump to confirm a fresh load in the popup diagnostic line

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
    if (!hit) return { grade: "–", color: UNKNOWN_COLOR, known: false, tiered: false, notes: "Not in the tier list." };
    const graded = TIER_COLOR[hit.tier];
    return {
      grade: graded ? hit.tier : "•", // some listed weapons have recommended perks but no tier
      color: graded || "#7d8590",
      known: true,
      tiered: Boolean(graded),
      rank: hit.rank,
      notes: hit.notes,
      category: hit.category,
      perks: hit.perks,
    };
  }

  // Duplicate-roll state.
  //   keepers:   instanceId set — the best copy to KEEP in each duplicate group.
  //   redundant: instanceId -> { name, count, m, keep } — worse copies to shard.
  let highlightOn = false;
  let redundant = new Map();
  let keepers = new Set();
  let computeError = "";
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
    /** icon basename -> perk name (perkKey'd) — to match DIM's icon-only plug circles */
    perkNameByIcon: new Map(),
  };

  // Loose key for matching perk names across the sheet and the manifest. Lowercases
  // and drops the "Enhanced" qualifier so an enhanced perk circle still matches the
  // sheet's base-name recommendation.
  const perkKey = (s) =>
    (s || "").toLowerCase().replace(/\benhanced\b/g, " ").replace(/\s+/g, " ").trim();

  // The trailing filename of an icon path/URL (e.g. ".../icons/abc123.jpg" -> "abc123.jpg").
  const iconBase = (s) => {
    const path = (s || "").split("?")[0];
    return path.slice(path.lastIndexOf("/") + 1);
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

    // Index every plug's icon -> name while the big table is in memory. DIM's perk
    // circles render only the icon (the name is hover-only), so we match the sheet's
    // recommended perk *names* to on-screen circles via the icon filename.
    for (const key in bigTable) {
      const def = bigTable[key];
      if (!def || !def.plug) continue; // only pluggable items (perks/mods)
      const nm = def.displayProperties?.name;
      const ic = def.displayProperties?.icon;
      if (!nm || !ic) continue;
      vault.perkNameByIcon.set(iconBase(ic), perkKey(nm));
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

  // Assemble what the badge shows: weapon-bound tier + notes + dupe verdict. The
  // recommended/your perks are no longer listed here — they're highlighted directly
  // on DIM's perk circles (see highlightPerks), so the tooltip stays about notes.
  function tierFor(item, def) {
    const name = def.displayProperties?.name || "";
    const t = lookupTier(name);
    const dupe = redundant.get(item.itemInstanceId);
    const keep = keepers.has(item.itemInstanceId);
    return {
      grade: t.grade,
      color: t.color,
      redundant: Boolean(dupe),
      keeper: keep,
      reasons: [
        t.known
          ? t.tiered
            ? `${name} — Tier ${t.grade}${t.rank ? ` · Rank ${t.rank}` : ""}${t.category ? ` (${t.category})` : ""}`
            : `${name} — listed (no tier rating)${t.category ? ` (${t.category})` : ""}`
          : `${name} — not in the tier list`,
        t.notes || "",
        keep ? "✓ Keep — best of your copies" : "",
        dupe ? `⚠ Shard — you own a better copy (${dupe.count} total)${dupe.locked ? " · unlock first" : ""}` : "",
      ].filter(Boolean),
    };
  }

  // --- Recommended-perk highlighting ----------------------------------------
  // The sheet recommends perks by name, in columns. perk1/perk2 are the meaningful
  // "god roll" perks (highlighted strongly); barrel/mag are secondary (subtler).
  const PERK_MARK = "data-va-perk";
  function recommendedNameTiers(t) {
    const m = new Map(); // perkKey -> "primary" | "secondary"
    if (!t.perks) return m;
    const add = (col, kind) => {
      for (const n of col || []) {
        const k = perkKey(n);
        if (k && !m.has(k)) m.set(k, kind);
      }
    };
    add(t.perks.perk1, "primary");
    add(t.perks.perk2, "primary");
    add(t.perks.barrel, "secondary");
    add(t.perks.mag, "secondary");
    return m;
  }

  // Glow the recommended perk circles inside one container (the item popup OR the
  // full Armory perk grid). We key off the weapon NAME in the container's title, not
  // a clicked instance — the Armory shows a weapon's whole perk pool, no instance —
  // and match the sheet's recommended names to DIM's icon-only circles via the icon.
  function highlightPerksIn(container) {
    const name = container.querySelector("h1")?.textContent?.trim();
    if (!name) return;
    const tiers = recommendedNameTiers(lookupTier(name));
    if (!tiers.size) return;

    for (const img of container.querySelectorAll("svg image")) {
      const href = img.getAttribute("href") || img.getAttribute("xlink:href") || "";
      if (!href) continue;
      const perk = vault.perkNameByIcon.get(iconBase(href));
      if (!perk) continue;
      const kind = tiers.get(perk);
      if (!kind) continue;
      const svg = img.closest("svg") || img;
      if (svg.getAttribute(PERK_MARK) === kind) continue;
      svg.setAttribute(PERK_MARK, kind);
    }
  }

  // Highlight everywhere a weapon's perks are shown: the item popup and the Armory.
  function highlightPerks() {
    if (!vault.perkNameByIcon.size || !Object.keys(tierMap).length) return;
    for (const c of document.querySelectorAll(".item-popup, .armory")) highlightPerksIn(c);
  }

  // --- Badge injection ------------------------------------------------------
  // Styles injected once. The badge lives inside DIM, so it borrows DIM's font
  // and renders with layered shadows, a crisp inner ring, a hover lift, and a
  // gentle enter animation so it reads as part of the popup, not bolted on.
  function ensureBadgeStyles() {
    if (document.getElementById("va-badge-styles")) return;
    const s = document.createElement("style");
    s.id = "va-badge-styles";
    s.textContent = `
      .va-badge {
        position: absolute; top: 8px; right: 10px; z-index: 5;
        box-sizing: border-box; min-width: 24px; height: 24px; padding: 0 6px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 6px;
        font-family: 'Open Sans', system-ui, sans-serif;
        font-weight: 700; font-size: 14px; line-height: 1;
        color: #0b0d10; cursor: default; user-select: none;
        -webkit-font-smoothing: antialiased;
        box-shadow:
          inset 0 0 0 1px rgba(255, 255, 255, 0.2),
          0 1px 2px rgba(0, 0, 0, 0.45),
          0 2px 8px rgba(0, 0, 0, 0.25);
        transition: transform 0.12s cubic-bezier(0.2, 0, 0, 1), box-shadow 0.12s cubic-bezier(0.2, 0, 0, 1);
        animation: va-badge-pop 0.18s cubic-bezier(0.2, 0, 0, 1);
      }
      .va-badge:hover {
        transform: scale(1.06);
        box-shadow:
          inset 0 0 0 1px rgba(255, 255, 255, 0.28),
          0 2px 4px rgba(0, 0, 0, 0.5),
          0 4px 12px rgba(0, 0, 0, 0.3);
      }
      .va-badge.va-redundant {
        box-shadow:
          inset 0 0 0 1px rgba(255, 255, 255, 0.2),
          0 0 0 2px #f85149,
          0 2px 8px rgba(0, 0, 0, 0.3);
      }
      .va-badge.va-keep {
        box-shadow:
          inset 0 0 0 1px rgba(255, 255, 255, 0.2),
          0 0 0 2px #3fb950,
          0 2px 8px rgba(0, 0, 0, 0.3);
      }
      @keyframes va-badge-pop {
        from { opacity: 0; transform: scale(0.85); }
        to { opacity: 1; transform: scale(1); }
      }
      .item[${SHARD_ATTR}] { transition: outline-color 0.12s ease; }
      /* Recommended perks, glowed right on DIM's own perk circles. Styled via a
         data-attribute, NOT a class: DIM owns these svgs' className (clsx) and
         overwrites it on every React re-render, so a class would get wiped on the
         grid. A data-attribute we set survives re-renders. The drop-shadow hugs the
         circle shape; gold = god-roll perk, dimmer = barrel/mag. */
      svg[${PERK_MARK}="primary"] {
        filter: drop-shadow(0 0 3px #e8a534) drop-shadow(0 0 7px #e8a534);
        transition: filter 0.12s ease;
      }
      svg[${PERK_MARK}="secondary"] {
        filter: drop-shadow(0 0 2px #e8a534) drop-shadow(0 0 4px #e8a534);
        transition: filter 0.12s ease;
      }
    `;
    document.head.appendChild(s);
  }

  function makeBadge(tier) {
    const el = document.createElement("div");
    el.setAttribute(BADGE_ATTR, "1");
    el.className = "va-badge" + (tier.keeper ? " va-keep" : tier.redundant ? " va-redundant" : "");
    el.title = tier.reasons.join("\n");
    el.textContent = tier.grade;
    el.style.background = tier.color;
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
    highlightPerks(); // popup + Armory, keyed off the weapon name in each title
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

  // Armor cleanup presets. We delegate the hard Armor 3.0 logic (tier, set-aware
  // stat dominance) to DIM's own search filters and just apply the query — DIM
  // keeps these correct as the sandbox changes. tier:<=3 also sweeps legacy
  // (pre-Edge-of-Fate) armor, which reads as tier 0.
  const ARMOR_QUERIES = {
    lowtier: "is:armor -is:exotic -is:locked tier:<=3",
    dupes: "is:armor -is:exotic -is:locked dupe:setbonus+statlower",
  };

  // --- Duplicate rolls: which copy to keep ----------------------------------
  // Does this copy have any of the recommended perks in each column?
  function matchInfo(instanceId, rec) {
    const have = new Set(perkNames(instanceId).map((n) => n.toLowerCase()));
    const any = (arr) => Array.isArray(arr) && arr.some((p) => have.has(p.toLowerCase()));
    return { p1: any(rec.perk1), p2: any(rec.perk2), barrel: any(rec.barrel), mag: any(rec.mag) };
  }

  // For each weapon you own multiple copies of, pick the single best to KEEP
  // (most recommended perks, then barrel/mag, then masterwork) and mark the rest
  // as shard candidates.
  function computeRedundant() {
    redundant = new Map();
    keepers = new Set();
    computeError = "";
    if (!vault.ready || !Object.keys(tierMap).length) return;

    try {
      // Group by weapon NAME, not itemHash — reissued/differently-sourced copies of the
      // same weapon have different hashes but are duplicates for keep-vs-shard purposes.
      const groups = new Map(); // normalized name -> { name, copies: [{ id, item }] }
      for (const [id, item] of vault.byInstance) {
        const def = vault.defs.get(item.itemHash);
        const name = def?.displayProperties?.name;
        if (!name) continue;
        if (excludeExotics && isExotic(def)) continue;
        const key = normalizeName(name);
        if (!groups.has(key)) groups.set(key, { name, copies: [] });
        groups.get(key).copies.push({ id, item });
      }

      for (const { name, copies } of groups.values()) {
        if (copies.length < 2) continue;
        const rec = lookupTier(name).perks;
        if (!rec) continue; // need recommended perks to judge

        const scored = copies.map((c) => {
          const m = matchInfo(c.id, rec);
          const perkScore = (m.p1 ? 1 : 0) + (m.p2 ? 1 : 0);
          const masterwork = ((c.item.state || 0) & STATE_MASTERWORK) !== 0;
          // perks dominate, then barrel/mag, then masterwork as a final tiebreak.
          const composite = perkScore * 1000 + ((m.barrel ? 1 : 0) + (m.mag ? 1 : 0)) * 100 + (masterwork ? 1 : 0);
          return { id: c.id, item: c.item, m, perkScore, composite, locked: ((c.item.state || 0) & STATE_LOCKED) !== 0 };
        });
        let bestPerk = 0;
        for (const s of scored) if (s.perkScore > bestPerk) bestPerk = s.perkScore;
        if (bestPerk <= 0) continue; // no copy has a wanted perk

        let keeper = scored[0];
        for (const s of scored) if (s.composite > keeper.composite) keeper = s;

        // Flag every worse copy — including locked ones (this user locks junk to avoid
        // accidental dismantles, then wants to decide). Lock state is surfaced, not hidden.
        const flagged = scored.filter((s) => s.id !== keeper.id);
        if (!flagged.length) continue;

        keepers.add(keeper.id);
        for (const s of flagged) {
          redundant.set(s.id, { name, count: copies.length, m: s.m, keep: keeper.m, locked: s.locked });
        }
      }
      console.log(TAG, `Duplicates: ${keepers.size} keepers, ${redundant.size} shard candidates.`);
    } catch (e) {
      computeError = String(e && e.message ? e.message : e);
      console.error(TAG, "computeRedundant failed:", e);
    }
  }

  function clearTile(tile) {
    tile.removeAttribute(SHARD_ATTR);
    tile.style.outline = "";
    tile.style.outlineOffset = "";
  }
  function markTile(tile, kind) {
    tile.setAttribute(SHARD_ATTR, kind); // "keep" | "shard"
    tile.style.outline = `2px solid ${kind === "keep" ? "#3fb950" : "#f85149"}`;
    tile.style.outlineOffset = "-2px";
    tile.style.borderRadius = "4px";
  }
  function applyHighlights() {
    if (!highlightOn) {
      document.querySelectorAll(`[${SHARD_ATTR}]`).forEach(clearTile);
      return;
    }
    // Drop stale outlines (e.g. after toggling exotics).
    document.querySelectorAll(`[${SHARD_ATTR}]`).forEach((tile) => {
      if (!keepers.has(tile.id) && !redundant.has(tile.id)) clearTile(tile);
    });
    for (const id of keepers) {
      const t = document.getElementById(id);
      if (t && t.getAttribute(SHARD_ATTR) !== "keep") markTile(t, "keep");
    }
    for (const id of redundant.keys()) {
      const t = document.getElementById(id);
      if (t && t.getAttribute(SHARD_ATTR) !== "shard") markTile(t, "shard");
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
    // Recompute on demand so we never depend on load-time ordering of vault vs tier list.
    if (vault.ready && Object.keys(tierMap).length) {
      computeRedundant();
      applyHighlights();
    }

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
    if (msg.type === "armorSearch") {
      const query = ARMOR_QUERIES[msg.preset] || "";
      const applied = msg.apply && query ? setDimSearch(query) : false;
      respond({ ok: Boolean(query), query, applied });
      return;
    }
  });

  // --- Wire up --------------------------------------------------------------
  function start() {
    ensureBadgeStyles();
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

    console.log(TAG, `active (${BUILD}) — click a weapon in DIM.`);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
