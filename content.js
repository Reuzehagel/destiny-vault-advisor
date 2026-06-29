/**
 * Vault Advisor — DIM Tier Badge
 *
 * The full in-page loop:
 *   click a weapon in DIM  ->  identify the exact instance  ->  look it up in the
 *   vault data cached in IndexedDB  ->  compute a tier  ->  draw a badge in the
 *   item popup's top-right.
 *
 * No OAuth, no API key, no DOM scraping for data — the data comes from DIM's own
 * `keyval-store` IndexedDB. A content script shares the host page's origin storage,
 * so it can open DIM's own IndexedDB directly (see the README for why this works).
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

  // Shared pure modules, attached to globalThis.VaultAdvisor by earlier-loaded content
  // scripts: naming.js (name keys) and render.js (the render DECISIONS — what the badge
  // says, which colour a tile is, which perk circles glow). content.js keeps only the
  // DOM poking that acts on those decisions.
  const { normalizeName, looseName, iconBase } = globalThis.VaultAdvisor || {};
  const { tileKind, badgeClass, verdictLines, recommendedTiers, glowTier, redundantQuery, TILE_COLOR } =
    globalThis.VaultAdvisor || {};

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

  // Duplicate-roll verdict, keyed by instanceId. Each entry is the engine's per-copy
  // evidence (role/hits/matched/depth/godRoll/unique) plus group context (total, name,
  // keeperHits, keeperDepth) for the tooltip. Scoring lives in keepshard.js — see CONTEXT.md.
  let highlightOn = false;
  let verdictById = new Map();
  let computeError = "";
  let excludeExotics = false;

  const roleCount = (role) => {
    let n = 0;
    for (const v of verdictById.values()) if (v.role === role) n++;
    return n;
  };
  // Keep a second copy when it's your only source of a recommended trait perk (e.g. the only
  // one that can roll Mega Kill Clip), instead of sharding it as a plain duplicate. Default ON:
  // never silently advise sharding your only access to a god-roll perk. Toggle in the popup.
  let keepCoverage = true;
  const isExotic = (def) => def?.inventory?.tierType === 6;

  // Protect-from-shard skip-list (the exclude-items feature). A copy carrying one of these
  // DIM tags — or a note matching one of the keywords — sits out of keep/shard scoring
  // entirely (engine role "protected"), so a roll you keep for PvP/a build is never advised
  // away. Tag/note DATA comes from the vault (dimvault.js); this is the POLICY that reads it,
  // kept next to the scoring call. Configured in the popup; defaults mirror the popup HTML.
  let protectTags = new Set(); // none protected by default; user opts in via the popup
  let protectNote = ""; // comma-separated keywords; empty = ignore notes

  /** In-memory index, loaded from IndexedDB by dimvault.js. Replaced wholesale on load;
   *  starts as an empty Vault (same shape) so early reads before load are safe. The
   *  shape is owned by dimvault.emptyVault — don't restate it here. */
  let vault = globalThis.VaultAdvisor.emptyVault();

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
  // The actual indexing lives in dimvault.js (VaultAdvisor.loadVault) — a pure
  // function over a {allKeys, get} source, tested with node:test. This is the REAL
  // source adapter: it owns DIM's keyval-store IndexedDB lifecycle (open / not-found
  // guard / close) and hands loadVault a thin reader over it.
  async function openKeyvalSource() {
    const { db, existed } = await openDB("keyval-store");
    if (!existed) {
      db.close(); // release the empty DB we just created before deleting it, or the delete blocks
      indexedDB.deleteDatabase("keyval-store");
      throw new Error("DIM cache not found — sign into DIM and let inventory load, then reload.");
    }
    return {
      allKeys: () => idbAllKeys(db, "keyval"),
      get: (k) => idbGet(db, "keyval", k),
      close: () => db.close(),
    };
  }

  async function loadVault() {
    const engine = globalThis.VaultAdvisor;
    if (!engine || !engine.loadVault) throw new Error("dimvault.js not loaded");
    const source = await openKeyvalSource();
    try {
      vault = await engine.loadVault(source); // replace the empty starter wholesale
    } finally {
      source.close();
    }
    console.log(
      TAG,
      `Vault loaded: ${vault.byInstance.size} instances, ${vault.defs.size} defs, ${vault.annotationByInstance.size} tagged.`,
    );
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

  // Assemble what the badge shows: weapon-bound tier + notes + the keep/shard verdict from
  // keepshard.js. Recommended/your perks aren't listed here — they're glowed directly on
  // DIM's perk circles (see highlightPerks), so the tooltip stays about the verdict.
  function tierFor(item, def) {
    const name = def.displayProperties?.name || "";
    const t = lookupTier(name);
    const vd = verdictById.get(item.itemInstanceId);
    const role = vd?.role || null;
    // The verdict sentence(s) are a pure decision — see render.verdictLines.
    const { verdict, why } = verdictLines(vd);

    return {
      grade: t.grade,
      color: t.color,
      role,
      // Only paint a keeper purple. A duplicate perfect roll you should bin is role "shard"
      // (advice wins) — it must not show the god-roll ring.
      godRoll: role === "keeper" && Boolean(vd?.godRoll),
      reasons: [
        t.known
          ? t.tiered
            ? `${name} — Tier ${t.grade}${t.rank ? ` · Rank ${t.rank}` : ""}${t.category ? ` (${t.category})` : ""}`
            : `${name} — listed (no tier rating)${t.category ? ` (${t.category})` : ""}`
          : `${name} — not in the tier list`,
        t.notes || "",
        verdict,
        why,
      ].filter(Boolean),
    };
  }

  // --- Recommended-perk highlighting ----------------------------------------
  // The sheet recommends perks by name, in columns. perk1/perk2 are the meaningful
  // "god roll" perks (highlighted strongly); barrel/mag are secondary (subtler). The
  // name→tier and icon→glow DECISIONS are render.recommendedTiers / render.glowTier.
  const PERK_MARK = "data-va-perk";

  // Glow the recommended perk circles inside one container (the item popup OR the
  // full Armory perk grid). We key off the weapon NAME in the container's title, not
  // a clicked instance — the Armory shows a weapon's whole perk pool, no instance —
  // and match the sheet's recommended names to DIM's icon-only circles via the icon.
  function highlightPerksIn(container) {
    const name = container.querySelector("h1")?.textContent?.trim();
    if (!name) return;
    const tiers = recommendedTiers(lookupTier(name).perks);
    // Don't early-return on an empty `tiers`: a reused container (navigating to a
    // weapon with no recommendations) still needs its old glows cleared below.

    for (const img of container.querySelectorAll("svg image")) {
      const svg = img.closest("svg") || img;
      const href = img.getAttribute("href") || img.getAttribute("xlink:href") || "";
      const names = href ? vault.perkNameByIcon.get(iconBase(href)) : null;
      // One icon can map to several plug names; glow if ANY is recommended, primary winning.
      const kind = glowTier(names, tiers);
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
      /* God roll — the perfect copy (every recommended trait option + a barrel + a mag).
         Purple ring + glow: distinct from DIM's gold perk glow and gold S-tier badge, so
         it actually stands out as "this is the one". */
      .va-badge.va-godroll {
        box-shadow:
          inset 0 0 0 1px rgba(255, 255, 255, 0.25),
          0 0 0 2px #c264fe,
          0 0 10px rgba(194, 100, 254, 0.7),
          0 2px 8px rgba(0, 0, 0, 0.3);
      }
      /* Coverage — fills a trait gap the keeper can't; keep-or-shard is your call (yellow). */
      .va-badge.va-coverage {
        box-shadow:
          inset 0 0 0 1px rgba(255, 255, 255, 0.2),
          0 0 0 2px #f5d442,
          0 2px 8px rgba(0, 0, 0, 0.3);
      }
      /* Protected — kept off the keep/shard decision by a DIM tag/note (slate ring). */
      .va-badge.va-protected {
        box-shadow:
          inset 0 0 0 1px rgba(255, 255, 255, 0.2),
          0 0 0 2px #8b949e,
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
    const cls = badgeClass(tier);
    el.className = cls ? "va-badge " + cls : "va-badge";
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

  // The one composable filter: a tier constraint AND an optional "has a shardable copy"
  // constraint, intersected. Empty tiers = no tier constraint; dupesOnly off = no dupe
  // constraint; both empty = everything (empty query clears DIM's search). Returns the DIM
  // name-OR query plus the live summary the popup shows (weapons matched, shardable copies
  // within them). Highlight is a separate live overlay — not part of the query.
  function buildFilterQuery(grades, dupesOnly) {
    const want = new Set(grades || []);
    // names: a Set restricts the match; null means "unconstrained" (everything).
    let names = null;
    if (want.size) {
      names = new Set();
      for (const { name, grade } of ownedTiered()) if (want.has(grade)) names.add(name);
    }
    if (dupesOnly) {
      // Every shard-role weapon is tier-listed (computeRedundant needs its perks), so a
      // weapon with a shardable copy is always a valid intersection candidate.
      const dupe = new Set();
      for (const vd of verdictById.values()) if (vd.role === "shard") dupe.add(vd.name);
      names = names ? new Set([...names].filter((n) => dupe.has(n))) : dupe;
    }
    // Shardable copies within the matched set (all of them when unconstrained).
    let shardable = 0;
    for (const vd of verdictById.values()) {
      if (vd.role === "shard" && (!names || names.has(vd.name))) shardable++;
    }
    const list = names ? [...names] : [];
    return {
      query: names ? redundantQuery(list) : "",
      weapons: names ? list.length : coverage().ownedWeapons,
      shardable,
    };
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

  // --- Duplicate rolls: which copy to keep ----------------------------------
  // Scoring lives in keepshard.js (globalThis.VaultAdvisor.rankGroup) — a pure module
  // tested with node:test. content.js resolves each copy's selectable perk NAMES from the
  // vault, calls rankGroup per weapon group, and renders the verdict below.

  // For each weapon you own multiple copies of, ask the engine which to keep (green),
  // which fills a gap (yellow, your call), and which to shard (red). content.js's job is
  // only to GROUP by weapon name and RESOLVE each copy's selectable perk names — the
  // scoring is keepshard.js's. The per-copy verdict is stored in verdictById for the badge
  // and tile outlines below.
  // Is this copy on the protect skip-list, and why? Returns a human reason (for the
  // tooltip) or null. POLICY over the vault's raw annotations: a configured tag, or a
  // note containing one of the user's keywords. The user picks the keywords, so a
  // {notes:"dismantle"} item is only spared if they literally type "dismantle".
  function protectionFor(id) {
    const ann = vault.annotationByInstance.get(String(id)); // dimvault keys annotations by String(id)
    if (!ann) return null;
    if (ann.tag && protectTags.has(ann.tag)) return `DIM "${ann.tag}" tag`;
    if (protectNote && ann.notes) {
      const hay = ann.notes.toLowerCase();
      const kw = protectNote
        .toLowerCase()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .find((k) => hay.includes(k));
      if (kw) return `note contains "${kw}"`;
    }
    return null;
  }

  function computeRedundant() {
    verdictById = new Map();
    computeError = "";
    if (!vault.ready || !Object.keys(tierMap).length) return;
    const engine = globalThis.VaultAdvisor;
    if (!engine || !engine.rankGroup) {
      computeError = "keepshard.js not loaded";
      console.warn(TAG, computeError);
      return;
    }

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

        // Resolve to the engine's plain-data Copy: selectable perk NAMES + masterwork.
        // protected = the tag/note skip-list reason (protectionFor) or false — a protected
        // copy sits out of scoring, and the engine echoes the reason onto its verdict entry
        // (protectedReason) so a kept PvP/build roll is never advised away.
        const input = copies.map((c) => ({
          id: c.id,
          selectable: selectablePerkNames(c.id),
          masterwork: ((c.item.state || 0) & STATE_MASTERWORK) !== 0,
          protected: protectionFor(c.id) || false,
        }));
        const v = engine.rankGroup(input, rec, { keepCoverage });
        if (!v) continue; // nothing worth coloring (no trait hit, etc.)

        // Representative keeper evidence, for a shard tile's "why" line.
        const keeperEntries = v.copies.filter((c) => c.role === "keeper");
        const keeperHits = [...new Set(keeperEntries.flatMap((k) => k.hits))];
        const keeperDepth = keeperEntries.reduce((mx, k) => Math.max(mx, k.depth), 0);
        for (const c of v.copies) {
          verdictById.set(c.id, { ...c, total: v.total, name, keeperHits, keeperDepth });
        }
      }
      console.log(TAG, `Duplicates: ${roleCount("keeper")} keepers, ${roleCount("coverage")} coverage, ${roleCount("shard")} shard candidates, ${roleCount("protected")} protected.`);
    } catch (e) {
      computeError = String(e && e.message ? e.message : e);
      console.error(TAG, "computeRedundant failed:", e);
    }
  }

  // Tile outline colour + kind per verdict role are render decisions (render.TILE_COLOR /
  // render.tileKind). content.js just paints them onto the DOM.
  function clearTile(tile) {
    tile.removeAttribute(SHARD_ATTR);
    tile.style.outline = "";
    tile.style.outlineOffset = "";
  }
  function markTile(tile, kind) {
    tile.setAttribute(SHARD_ATTR, kind); // "keep" | "godroll" | "coverage" | "shard"
    tile.style.outline = `2px solid ${TILE_COLOR[kind] || "#3fb950"}`;
    tile.style.outlineOffset = "-2px";
    tile.style.borderRadius = "4px";
  }
  function applyHighlights() {
    if (!highlightOn) {
      document.querySelectorAll(`[${SHARD_ATTR}]`).forEach(clearTile);
      return;
    }
    // Drop stale outlines (e.g. after toggling exotics, or a copy that lost its role).
    document.querySelectorAll(`[${SHARD_ATTR}]`).forEach((tile) => {
      const vd = verdictById.get(tile.id);
      if (!vd || !tileKind(vd)) clearTile(tile);
    });
    for (const [id, vd] of verdictById) {
      const kind = tileKind(vd);
      if (!kind) continue;
      const t = document.getElementById(id);
      if (t && t.getAttribute(SHARD_ATTR) !== kind) markTile(t, kind);
    }
  }

  // Read one of DIM's full manifest tables from the keyval source. dimvault.loadVault keeps
  // only owned defs; a whole-sheet wishlist needs the full InventoryItem + PlugSet tables to
  // resolve each weapon's rollable perks, so we read them on demand (an explicit user action)
  // and let them go once indexed.
  async function readTable(source, keys, name) {
    // Exact key first, then a loose contains-match — mirrors dimvault.js, so a versioned/renamed
    // DIM key still resolves instead of failing only on the wishlist path.
    const key = keys.find((k) => k === `d2-manifest-${name}`) || keys.find((k) => k.includes(name));
    if (!key) throw new Error(`${name} manifest not cached yet — let DIM finish loading once.`);
    const table = await source.get(key);
    if (!table) throw new Error(`${name} manifest is empty — let DIM finish loading once.`);
    return table;
  }

  // Generate a DIM wishlist from the tier sheet, scoped to the selected grades (empty = all,
  // including untiered weapons that still carry recommended perks). Pure generation lives in
  // wishlist.js; here we only supply the sheet entries and the manifest-backed lookups.
  async function generateWishlist(tiers, mode) {
    const engine = globalThis.VaultAdvisor;
    if (!engine || !engine.buildWishlist || !engine.buildLookups) throw new Error("wishlist.js not loaded");
    if (!Object.keys(tierMap).length) throw new Error("tier sheet not loaded yet");
    const want = new Set(tiers);
    const entries = Object.values(tierMap).filter((e) => !want.size || want.has(e.tier));
    const source = await openKeyvalSource();
    let itemTable, plugSetTable;
    try {
      const keys = await source.allKeys();
      [itemTable, plugSetTable] = await Promise.all([
        readTable(source, keys, "InventoryItem"),
        readTable(source, keys, "PlugSet"),
      ]);
    } finally {
      source.close();
    }
    const { text, stats } = engine.buildWishlist(entries, engine.buildLookups(itemTable, plugSetTable), mode);
    return { ok: true, text, stats };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (!msg) return;
    // Every message carries the popup's current settings; adopt them before recomputing.
    if ("excludeExotics" in msg) excludeExotics = Boolean(msg.excludeExotics);
    if ("keepCoverage" in msg) keepCoverage = Boolean(msg.keepCoverage);
    if ("protectTags" in msg) protectTags = new Set(Array.isArray(msg.protectTags) ? msg.protectTags : []);
    if ("protectNote" in msg) protectNote = String(msg.protectNote || "");
    if ("highlight" in msg) highlightOn = Boolean(msg.highlight); // live overlay, set by its own switch
    // Recompute on demand so we never depend on load-time ordering of vault vs tier list. The
    // wishlist path reads neither keep/shard verdicts nor tiles, so skip the recompute + repaint.
    if (msg.type !== "wishlist" && vault.ready && Object.keys(tierMap).length) {
      computeRedundant();
      applyHighlights();
    }

    // sync: live poll behind every popup toggle — returns the tier bars, the filter summary
    // (weapons matched + shardable within them) for the current tiers/dupesOnly, and the
    // persisted flags so the popup can reflect them.
    if (msg.type === "sync") {
      const f = vault.ready ? buildFilterQuery(msg.tiers || [], Boolean(msg.dupesOnly)) : { weapons: 0, shardable: 0 };
      respond({
        ok: vault.ready,
        ready: vault.ready,
        counts: vault.ready ? tierCounts() : {},
        weapons: f.weapons,
        shardable: f.shardable,
        highlightOn,
        excludeExotics,
        keepCoverage,
        protectTags: [...protectTags],
        protectNote,
      });
      return;
    }
    // apply: build the combined query and (when apply) write it into DIM's search box.
    if (msg.type === "apply") {
      if (!vault.ready) {
        respond({ ok: false, error: "vault not loaded yet" });
        return;
      }
      const f = buildFilterQuery(msg.tiers || [], Boolean(msg.dupesOnly));
      const applied = msg.apply ? setDimSearch(f.query) : false;
      respond({ ok: true, query: f.query, weapons: f.weapons, shardable: f.shardable, applied });
      return;
    }
    // wishlist: build a DIM wishlist from the sheet, scoped to the selected tiers. Async
    // (reads the multi-MB manifest), so respond later and keep the channel open with `true`.
    if (msg.type === "wishlist") {
      generateWishlist(msg.tiers || [], msg.mode)
        .then(respond)
        .catch((e) => respond({ ok: false, error: String(e && e.message ? e.message : e) }));
      return true;
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
