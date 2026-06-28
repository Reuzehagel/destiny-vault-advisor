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
  const BUILD = "perks-v7"; // bump to confirm a fresh load in the popup diagnostic line

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
  let keeperInfo = new Map(); // keeper instanceId -> its matchInfo (for the "why keep" tooltip)
  let keeperUnique = new Map(); // secondary-keeper instanceId -> [recommended perks only it can roll]
  let computeError = "";
  let excludeExotics = false;
  // Keep a second copy when it's your only source of a recommended trait perk (e.g. the only
  // one that can roll Mega Kill Clip), instead of sharding it as a plain duplicate. Default ON:
  // never silently advise sharding your only access to a god-roll perk. Toggle in the popup.
  let keepCoverage = true;
  const isExotic = (def) => def?.inventory?.tierType === 6;

  /** In-memory index built once from IndexedDB. */
  const vault = {
    ready: false,
    error: null,
    /** instanceId -> { item, hash } */
    byInstance: new Map(),
    /** hash -> trimmed InventoryItem def (only owned + plug hashes) */
    defs: new Map(),
    /** instanceId -> [plugHash, ...] (visible, enabled sockets — the currently socketed perks) */
    socketsByInstance: new Map(),
    /** instanceId -> [plugHash, ...] every SELECTABLE perk across sockets — for multi-perk
     *  drops (two togglable traits per column) and crafted weapons, this is wider than what's
     *  currently socketed. For plain random rolls it's just the rolled perks. */
    selectableByInstance: new Map(),
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
      db.close(); // release the empty DB we just created before deleting it, or the delete blocks
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
      const reusableData = profile.itemComponents?.reusablePlugs?.data || {};
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

          // Many modern weapons drop with TWO selectable perks per column that you can
          // freely toggle between (no crafting required). DIM caches every selectable plug
          // in the ItemReusablePlugs component, so for keep/shard scoring we credit any
          // recommended perk the roll CAN present — not just the one currently socketed.
          // For a plain random roll each socket lists only its single rolled perk, so this
          // is a no-op there.
          const bySocket = reusableData[item.itemInstanceId]?.plugs || {};
          const selectable = [];
          for (const col in bySocket) {
            for (const p of bySocket[col] || []) if (p?.plugItemHash) selectable.push(p.plugItemHash);
          }
          if (selectable.length) {
            vault.selectableByInstance.set(item.itemInstanceId, selectable);
            for (const h of selectable) neededHashes.add(h);
          }
        }
      }
    }

    // Read the (big) InventoryItem table once, keep only the defs we need, drop the rest.
    const itemDefKey = keys.find((k) => /^d2-manifest-InventoryItem$/.test(k)) || keys.find((k) => /InventoryItem/.test(k));
    if (!itemDefKey) throw new Error("InventoryItem manifest table not cached yet.");
    const bigTable = await idbGet(db, "keyval", itemDefKey);
    if (!bigTable) throw new Error("InventoryItem manifest table is empty — let DIM finish loading once.");
    for (const h of neededHashes) {
      const def = bigTable[h] ?? bigTable[String(h)];
      if (def) vault.defs.set(h, def);
    }

    // Index every plug's icon -> name(s) while the big table is in memory. DIM's perk
    // circles render only the icon (the name is hover-only), so we match the sheet's
    // recommended perk *names* to on-screen circles via the icon filename. Multiple
    // plugs can SHARE one icon (e.g. "One for All" and the mod "One for All Refit"),
    // so map each icon to a SET of names — a single last-write-wins value silently
    // dropped the perk whenever a same-art plug with a higher hash existed.
    for (const key in bigTable) {
      const def = bigTable[key];
      if (!def || !def.plug) continue; // only pluggable items (perks/mods)
      const nm = def.displayProperties?.name;
      const ic = def.displayProperties?.icon;
      if (!nm || !ic) continue;
      const base = iconBase(ic);
      let set = vault.perkNameByIcon.get(base);
      if (!set) vault.perkNameByIcon.set(base, (set = new Set()));
      set.add(perkKey(nm));
    }
    db.close();

    vault.ready = true;
    console.log(TAG, `Vault loaded: ${vault.byInstance.size} instances, ${vault.defs.size} defs.`);
  }

  // The perks on the held roll — shown in the tooltip as context, NOT used to pick
  // the tier (tier is weapon-bound). Useful later for "is this a god roll?" matching.
  function plugNames(plugs) {
    return (plugs || [])
      .map((h) => vault.defs.get(h)?.displayProperties?.name)
      .filter(Boolean)
      .filter((n) => !PERK_NAME_BLOCKLIST.some((re) => re.test(n)));
  }

  function perkNames(instanceId) {
    return plugNames(vault.socketsByInstance.get(instanceId));
  }

  // Every recommended perk this copy can PRESENT — the socketed perks plus, for multi-perk
  // drops/crafted weapons, the alternate selectable perks it can be toggled to. This is what
  // keep/shard scoring matches against, so a copy isn't penalised for which of its togglable
  // perks happens to be socketed right now.
  function selectablePerkNames(instanceId) {
    const selectable = vault.selectableByInstance.get(instanceId);
    if (!selectable) return perkNames(instanceId); // component absent — score as-socketed
    // Union socketed ∪ selectable: reusablePlugs normally already lists the socketed perk,
    // but unioning guarantees we never drop it if the component is sparse for a socket.
    const names = new Set(perkNames(instanceId));
    for (const n of plugNames(selectable)) names.add(n);
    return [...names];
  }

  // Assemble what the badge shows: weapon-bound tier + notes + dupe verdict. The
  // recommended/your perks are no longer listed here — they're highlighted directly
  // on DIM's perk circles (see highlightPerks), so the tooltip stays about notes.
  function tierFor(item, def) {
    const name = def.displayProperties?.name || "";
    const t = lookupTier(name);
    const dupe = redundant.get(item.itemInstanceId);
    const keep = keepers.has(item.itemInstanceId);

    // Why this copy is the keeper / a shard candidate — the recommended perks it
    // has vs the keeper's, so the verdict explains itself instead of just asserting.
    // "has" when the perks are socketed; "can roll" when they're a selectable second perk
    // on a multi-perk drop — so the verdict doesn't claim a perk is equipped when it isn't.
    const verb = (m) => (m?.togglable ? "can roll" : "has");
    let keepLine = "";
    if (keep) {
      const unique = keeperUnique.get(item.itemInstanceId);
      if (unique && unique.length) {
        // A secondary keeper held only because it's your sole source of these perks.
        keepLine = `✓ Keep — your only copy that can roll ${unique.join(" + ")}`;
      } else {
        const m = keeperInfo.get(item.itemInstanceId);
        const hits = recHits(m);
        keepLine = hits.length
          ? `✓ Keep — best roll: ${verb(m) === "can roll" ? "can roll " : ""}${hits.join(" + ")}`
          : "✓ Keep — best of your copies";
      }
    }
    let shardLine = "";
    let shardWhy = "";
    if (dupe) {
      shardLine = `⚠ Shard — you own a better copy (${dupe.count} total)${dupe.locked ? " · unlock first" : ""}`;
      const keepHits = recHits(dupe.keep);
      const mineHits = recHits(dupe.m);
      // When both copies cover the same perks, the decider is depth (more switchable
      // recommended options) — say so, or the two lines look identical and unexplained.
      const moreOptions = (dupe.keep?.depth || 0) > (dupe.m?.depth || 0);
      shardWhy = moreOptions
        ? `· keeper has more recommended perks to switch between (${dupe.keep.depth} vs ${dupe.m.depth})`
        : `· keeper ${verb(dupe.keep)} ${keepHits.length ? keepHits.join(" + ") : "more recommended perks"}` +
          `; this ${mineHits.length ? `${verb(dupe.m)} ${mineHits.join(" + ")}` : "has none of the recommended perks"}`;
    }

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
        keepLine,
        shardLine,
        shardWhy,
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
    // Don't early-return on an empty `tiers`: a reused container (navigating to a
    // weapon with no recommendations) still needs its old glows cleared below.

    for (const img of container.querySelectorAll("svg image")) {
      const svg = img.closest("svg") || img;
      const href = img.getAttribute("href") || img.getAttribute("xlink:href") || "";
      const names = href ? vault.perkNameByIcon.get(iconBase(href)) : null;
      // One icon can map to several plug names; glow if ANY is recommended, and let a
      // primary (god-roll) match win over a secondary (barrel/mag) one.
      let kind;
      if (names) {
        for (const n of names) {
          const k = tiers.get(n);
          if (k === "primary") { kind = "primary"; break; }
          if (k) kind = k;
        }
      }
      // Set OR clear: DIM reuses the .item-popup / .armory node and swaps the icon in
      // place on re-render, so a circle that no longer earns a glow (different weapon,
      // or a primary that's now only secondary) must lose its old mark — not just keep it.
      if (kind) {
        if (svg.getAttribute(PERK_MARK) !== kind) svg.setAttribute(PERK_MARK, kind);
      } else if (svg.hasAttribute(PERK_MARK)) {
        svg.removeAttribute(PERK_MARK);
      }
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

  // React owns DIM's search box value, so we write through the native setter to make
  // the change "real" before dispatching input/change. The descriptor is constant —
  // resolve it once, not on every Apply.
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;

  function setDimSearch(query) {
    const inputs = [...document.querySelectorAll(".search-filter input")];
    const input = inputs.find((i) => i.offsetParent !== null) || inputs[0];
    if (!input) return false;
    nativeInputValueSetter.call(input, query);
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
    // Map of perkKey -> the copy's actual display name, so we can both test membership
    // and report which recommended perk this copy actually has. Keying by perkKey (not
    // a plain lowercase) means Enhanced variants count too, matching the glow logic — an
    // "Enhanced Chill Clip" roll now scores the same as the recommended "Chill Clip".
    // Match against every SELECTABLE perk (a multi-perk drop can toggle to the god roll),
    // and note which perks are togglable-but-not-socketed so the tooltip can say so.
    const have = new Map(selectablePerkNames(instanceId).map((n) => [perkKey(n), n]));
    const socketed = new Set(perkNames(instanceId).map((n) => perkKey(n)));
    const hit = (arr) => (Array.isArray(arr) ? arr.map((p) => have.get(perkKey(p))).find(Boolean) || null : null);
    // How many DISTINCT recommended options in a column the copy can present. A multi-perk
    // copy that can roll BOTH Demolitionist AND Rimestealer in slot 1 has more good options
    // than one stuck with only Rimestealer — that extra flexibility is real and should count.
    const count = (arr) => (Array.isArray(arr) ? arr.filter((p) => have.has(perkKey(p))).length : 0);
    const n1 = hit(rec.perk1), n2 = hit(rec.perk2), nb = hit(rec.barrel), nm = hit(rec.mag);
    // Total recommended options across all columns — the "good perks" count, used as a
    // tiebreak below column coverage so more switchable god-roll perks wins.
    const depth = count(rec.perk1) + count(rec.perk2) + count(rec.barrel) + count(rec.mag);
    // Every DISTINCT recommended TRAIT perk (perk1/perk2) this copy can present, by their
    // sheet names. Used by the keep-coverage pass to spot a copy that's your only source of a
    // god-roll trait (e.g. the only one that can roll Mega Kill Clip). Traits only — barrel/mag
    // variety isn't worth a vault slot.
    const traitNames = [];
    const seenTrait = new Set();
    for (const p of [...(rec.perk1 || []), ...(rec.perk2 || [])]) {
      const k = perkKey(p);
      if (have.has(k) && !seenTrait.has(k)) { seenTrait.add(k); traitNames.push(p); }
    }
    // A perk1/perk2 god-roll trait that's available but not currently socketed = "can toggle".
    const togglable = [n1, n2].some((n) => n && !socketed.has(perkKey(n)));
    return {
      p1: !!n1, p2: !!n2, barrel: !!nb, mag: !!nm, depth, togglable, traitNames,
      names: { p1: n1, p2: n2, barrel: nb, mag: nm },
    };
  }

  // The recommended perks a copy actually has, perk1/perk2 first (the god-roll traits).
  function recHits(m) {
    return [m?.names?.p1, m?.names?.p2].filter(Boolean);
  }

  // For each weapon you own multiple copies of, pick the best to KEEP (most recommended
  // perks, then barrel/mag, then depth, then masterwork) and mark the rest as shard
  // candidates. With keep-coverage on, also keep any extra copy that's your only source of
  // a recommended trait perk the best copy can't roll.
  function computeRedundant() {
    redundant = new Map();
    keepers = new Set();
    keeperInfo = new Map();
    keeperUnique = new Map();
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
          // Score order: column coverage (is it the god roll?) dominates, then barrel/mag
          // coverage, then DEPTH (how many recommended options it can switch between — so a
          // copy with both Demo and Rime beats one with just Rime), then masterwork.
          // depth is capped so it can never outrank a barrel/mag column (max realistic depth
          // is well under 10).
          const composite =
            perkScore * 1000 +
            ((m.barrel ? 1 : 0) + (m.mag ? 1 : 0)) * 100 +
            Math.min(m.depth, 9) * 10 +
            (masterwork ? 1 : 0);
          return { id: c.id, item: c.item, m, perkScore, composite, locked: ((c.item.state || 0) & STATE_LOCKED) !== 0 };
        });
        let bestPerk = 0;
        for (const s of scored) if (s.perkScore > bestPerk) bestPerk = s.perkScore;
        if (bestPerk <= 0) continue; // no copy has a wanted perk

        // The single best copy by composite is always the primary keeper.
        const ranked = [...scored].sort((a, b) => b.composite - a.composite);
        const primary = ranked[0];

        // Keep-coverage pass: also keep any copy that's your ONLY source of a recommended
        // trait perk the kept set can't already roll (e.g. the only copy with Mega Kill Clip).
        // Greedy, best-first, and bounded by the recommended pool — once every god-roll trait
        // is covered, remaining copies are sharded. Toggle OFF → only the single best is kept.
        const kept = [primary];
        const covered = new Set(primary.m.traitNames.map((n) => perkKey(n)));
        if (keepCoverage) {
          for (const s of ranked.slice(1)) {
            const adds = s.m.traitNames.filter((n) => !covered.has(perkKey(n)));
            if (!adds.length) continue;
            kept.push(s);
            s.adds = adds; // the recommended perks only this copy brings — for the tooltip
            for (const n of adds) covered.add(perkKey(n));
          }
        }

        // Flag every copy we didn't keep — including locked ones (this user locks junk to
        // avoid accidental dismantles, then wants to decide). Lock state is surfaced, not hidden.
        const keptIds = new Set(kept.map((k) => k.id));
        const flagged = scored.filter((s) => !keptIds.has(s.id));
        if (!flagged.length) continue;

        keepers.add(primary.id);
        keeperInfo.set(primary.id, primary.m);
        for (const s of kept.slice(1)) {
          keepers.add(s.id);
          keeperInfo.set(s.id, s.m);
          keeperUnique.set(s.id, s.adds);
        }
        for (const s of flagged) {
          redundant.set(s.id, { name, count: copies.length, m: s.m, keep: primary.m, locked: s.locked });
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
    if ("excludeExotics" in msg) excludeExotics = Boolean(msg.excludeExotics); // sync with popup
    if ("keepCoverage" in msg) keepCoverage = Boolean(msg.keepCoverage); // sync with popup
    // Recompute on demand so we never depend on load-time ordering of vault vs tier list.
    // (One pass per message — the block below already covers the exotics-toggle case.)
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
        keepers: keepers.size,
        coverageKept: keeperUnique.size,
        highlightOn,
        excludeExotics,
        keepCoverage,
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
