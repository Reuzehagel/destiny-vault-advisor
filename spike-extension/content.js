/**
 * DIM IndexedDB Spike — content script.
 *
 * Goal: prove that an extension content script running on app.destinyitemmanager.com
 * can read DIM's cached data straight out of the page-origin IndexedDB, with NO
 * OAuth, NO Bungie API key, and NO DOM scraping.
 *
 * What it does (all read-only):
 *   1. Opens DIM's `keyval-store` IndexedDB (store name `keyval`).
 *   2. Lists every key, reads `accounts`, reads the cached `profile-{membershipId}`.
 *   3. Counts all owned items (vault + characters + equipped).
 *   4. Finds the cached InventoryItem manifest table and resolves ONE weapon
 *      end-to-end: itemHash -> name, type, tier, perks, instance stats.
 *
 * Output: a floating panel (top-left) + a "Copy report" button, and a full
 * console dump under the [DIM-SPIKE] tag. The copied report is safe to paste
 * back — it contains counts + a single sample item, not your whole vault.
 */
(async () => {
  const TAG = "[DIM-SPIKE]";
  // DIM blanks inventory.tierTypeName to save space but keeps the numeric tierType.
  const TIER_TYPE_NAMES = {
    0: "Unknown",
    1: "Currency",
    2: "Basic",
    3: "Common",
    4: "Rare",
    5: "Legendary",
    6: "Exotic",
  };
  const report = {
    ok: false,
    when: new Date().toISOString(),
    origin: location.origin,
    contentScriptCanReadIDB: false,
    manifestVersion: null,
    manifestTablesCached: [],
    keyvalKeys: [],
    accounts: [],
    profiles: [],
    sampleWeapon: null,
    notes: [],
  };
  const note = (m) => {
    report.notes.push(m);
    console.log(TAG, m);
  };

  // --- tiny promisified IndexedDB helpers -----------------------------------
  const openDB = (name) =>
    new Promise((resolve, reject) => {
      let existed = true;
      const req = indexedDB.open(name);
      req.onupgradeneeded = () => {
        existed = false; // open() created it -> it wasn't there before
      };
      req.onsuccess = () => resolve({ db: req.result, existed });
      req.onerror = () => reject(req.error);
    });

  const idbGet = (db, store, key) =>
    new Promise((resolve, reject) => {
      const req = db.transaction(store, "readonly").objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  const idbAllKeys = (db, store) =>
    new Promise((resolve, reject) => {
      const req = db.transaction(store, "readonly").objectStore(store).getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  try {
    // --- localStorage: manifest version (lives outside IDB) ------------------
    report.manifestVersion = localStorage.getItem("d2-manifest-version");

    // --- enumerate databases (nice-to-have; supported FF126+/Chrome) --------
    if (indexedDB.databases) {
      const dbs = await indexedDB.databases();
      note(`IndexedDB databases on this origin: ${dbs.map((d) => d.name).join(", ") || "(none)"}`);
    }

    // --- open DIM's keyval store --------------------------------------------
    const { db, existed } = await openDB("keyval-store");
    if (!existed) {
      note(
        "keyval-store did not exist yet — open DIM, sign in, let your inventory finish loading, then reload this page.",
      );
      db.close();
      indexedDB.deleteDatabase("keyval-store"); // clean up the empty DB we just made
      return finish(report);
    }
    if (!db.objectStoreNames.contains("keyval")) {
      note(`keyval-store has no 'keyval' store. Stores present: ${[...db.objectStoreNames].join(", ")}`);
      db.close();
      return finish(report);
    }

    report.contentScriptCanReadIDB = true;
    note("SUCCESS: content script opened DIM's keyval-store.");

    // --- list keys ----------------------------------------------------------
    const keys = (await idbAllKeys(db, "keyval")).map(String);
    report.keyvalKeys = keys;
    report.manifestTablesCached = keys.filter((k) => k.startsWith("d2-manifest-"));
    note(`Found ${keys.length} keys. Manifest tables cached: ${report.manifestTablesCached.length}.`);

    // --- accounts -----------------------------------------------------------
    const accounts = (await idbGet(db, "keyval", "accounts")) || [];
    report.accounts = accounts.map((a) => ({
      membershipId: a.membershipId,
      destinyVersion: a.destinyVersion,
      platformLabel: a.platformLabel ?? a.originalPlatformType,
      displayName: a.displayName,
    }));

    // --- profiles (one per cached profile-* key) ----------------------------
    const profileKeys = keys.filter((k) => k.startsWith("profile-"));
    let firstProfile = null;
    let firstProfileKey = null;
    for (const pk of profileKeys) {
      const p = await idbGet(db, "keyval", pk);
      if (!p) continue;
      const counts = countItems(p);
      report.profiles.push({
        key: pk,
        mintedTimestamp: p.responseMintedTimestamp ?? null,
        ...counts,
      });
      if (!firstProfile) {
        firstProfile = p;
        firstProfileKey = pk;
      }
    }

    // --- resolve a sample weapon through the manifest -----------------------
    if (firstProfile) {
      const itemDefKey =
        report.manifestTablesCached.find((k) => /InventoryItem$/i.test(k)) ||
        report.manifestTablesCached.find((k) => /InventoryItem/i.test(k));
      if (!itemDefKey) {
        note("No InventoryItem manifest table cached — can't resolve names. Let DIM finish loading once.");
      } else {
        const defs = await idbGet(db, "keyval", itemDefKey);
        report.sampleWeapon = resolveSampleWeapon(firstProfile, defs, firstProfileKey);
        if (report.sampleWeapon) {
          note(
            `Resolved a real item end-to-end: "${report.sampleWeapon.name}" (${report.sampleWeapon.type}).`,
          );
        }
      }
    } else {
      note("No cached profile found. Sign into DIM and let your inventory load, then reload.");
    }

    db.close();
    report.ok = report.contentScriptCanReadIDB;
    finish(report);
  } catch (e) {
    note(`ERROR: ${e && e.message ? e.message : String(e)}`);
    console.error(TAG, e);
    finish(report);
  }

  // --- helpers --------------------------------------------------------------
  function countItems(profile) {
    let owned = 0;
    let instanced = 0;
    const bump = (arr) => {
      for (const it of arr || []) {
        owned++;
        if (it.itemInstanceId) instanced++;
      }
    };
    bump(profile.profileInventory?.data?.items);
    for (const c of Object.values(profile.characterInventories?.data || {})) bump(c.items);
    for (const c of Object.values(profile.characterEquipment?.data || {})) bump(c.items);
    return {
      ownedItems: owned,
      instancedItems: instanced,
      hasInstanceStats: Boolean(profile.itemComponents?.stats?.data),
      hasSockets: Boolean(profile.itemComponents?.sockets?.data),
    };
  }

  // Manifest tables are stored as a plain { [hash]: definition } map.
  function defLookup(defs, hash) {
    if (!defs) return undefined;
    return defs[hash] ?? defs[String(hash)];
  }

  function resolveSampleWeapon(profile, defs, profileKey) {
    const all = [];
    const push = (arr) => arr && all.push(...arr);
    push(profile.profileInventory?.data?.items);
    for (const c of Object.values(profile.characterInventories?.data || {})) push(c.items);
    for (const c of Object.values(profile.characterEquipment?.data || {})) push(c.items);

    const instanceStats = profile.itemComponents?.stats?.data || {};
    const socketData = profile.itemComponents?.sockets?.data || {};

    // Prefer an instanced weapon (itemCategoryHashes contains 1 = Weapon).
    for (const item of all) {
      if (!item.itemInstanceId) continue;
      const def = defLookup(defs, item.itemHash);
      if (!def) continue;
      const cats = def.itemCategoryHashes || [];
      if (!cats.includes(1)) continue; // 1 = Weapon

      const stats = instanceStats[item.itemInstanceId]?.stats || {};
      const sockets = socketData[item.itemInstanceId]?.sockets || [];
      const perks = sockets
        .filter((s) => s.isVisible && s.plugHash)
        .map((s) => defLookup(defs, s.plugHash)?.displayProperties?.name)
        .filter(Boolean)
        .slice(0, 8);

      return {
        fromProfile: profileKey,
        name: def.displayProperties?.name,
        type: def.itemTypeDisplayName,
        // DIM blanks tierTypeName; read the numeric tierType enum instead.
        tier: TIER_TYPE_NAMES[def.inventory?.tierType] ?? def.inventory?.tierType ?? "",
        itemHash: item.itemHash,
        itemInstanceId: item.itemInstanceId,
        statHashesWithValues: Object.entries(stats)
          .slice(0, 10)
          .map(([h, v]) => ({ statHash: Number(h), value: v.value })),
        samplePerks: perks,
      };
    }
    return null;
  }

  // --- UI panel -------------------------------------------------------------
  function finish(r) {
    console.log(TAG, "FULL REPORT:", r);
    try {
      renderPanel(r);
    } catch (e) {
      console.error(TAG, "panel render failed", e);
    }
  }

  function renderPanel(r) {
    document.getElementById("dim-spike-panel")?.remove();
    const ok = r.contentScriptCanReadIDB;
    const wrap = document.createElement("div");
    wrap.id = "dim-spike-panel";
    wrap.style.cssText = [
      "position:fixed",
      "top:12px",
      "left:12px",
      "z-index:2147483647",
      "max-width:420px",
      "font:12px/1.45 ui-monospace,Menlo,Consolas,monospace",
      "color:#e8e8ea",
      "background:#16181d",
      `border:1px solid ${ok ? "#2ea043" : "#a33"}`,
      "border-radius:10px",
      "box-shadow:0 8px 30px rgba(0,0,0,.5)",
      "padding:12px 14px",
    ].join(";");

    const sample = r.sampleWeapon;
    const line = (label, val) =>
      `<div style="display:flex;gap:8px;justify-content:space-between"><span style="opacity:.6">${label}</span><span>${val}</span></div>`;

    wrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <strong style="font-size:13px;color:${ok ? "#3fb950" : "#ff6b6b"}">DIM IDB Spike — ${ok ? "READ OK" : "NO DATA"}</strong>
      </div>
      ${line("Manifest version", r.manifestVersion ?? "—")}
      ${line("Manifest tables cached", r.manifestTablesCached.length)}
      ${line("keyval keys", r.keyvalKeys.length)}
      ${line("Accounts", r.accounts.length)}
      ${line("Profiles cached", r.profiles.length)}
      ${r.profiles.map((p) => line("&nbsp;&nbsp;owned / instanced", `${p.ownedItems} / ${p.instancedItems}`)).join("")}
      ${
        sample
          ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #2a2d34">
               <div style="opacity:.6;margin-bottom:2px">Resolved sample weapon</div>
               <div style="color:#9ecbff">${sample.name ?? "?"}</div>
               <div style="opacity:.7">${sample.type ?? ""} · ${sample.tier ?? ""}</div>
               <div style="opacity:.55;margin-top:2px">${(sample.samplePerks || []).join(", ")}</div>
             </div>`
          : `<div style="margin-top:8px;opacity:.7">No sample resolved (see notes).</div>`
      }
      ${
        r.notes.length
          ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #2a2d34;opacity:.75">${r.notes
              .map((n) => `• ${n}`)
              .join("<br>")}</div>`
          : ""
      }
      <div style="display:flex;gap:8px;margin-top:10px">
        <button id="dim-spike-copy" style="flex:1;cursor:pointer;background:#238636;border:0;color:#fff;border-radius:6px;padding:6px 8px;font:inherit">Copy report</button>
        <button id="dim-spike-close" style="cursor:pointer;background:#30343c;border:0;color:#ddd;border-radius:6px;padding:6px 10px;font:inherit">×</button>
      </div>
    `;
    document.body.appendChild(wrap);

    wrap.querySelector("#dim-spike-close").onclick = () => wrap.remove();
    wrap.querySelector("#dim-spike-copy").onclick = async () => {
      const btn = wrap.querySelector("#dim-spike-copy");
      try {
        await navigator.clipboard.writeText(JSON.stringify(r, null, 2));
        btn.textContent = "Copied ✓";
      } catch {
        // Clipboard API can be blocked; fall back to console.
        console.log(TAG, "COPYABLE REPORT:\n" + JSON.stringify(r, null, 2));
        btn.textContent = "See console";
      }
      setTimeout(() => (btn.textContent = "Copy report"), 1600);
    };
  }
})();
