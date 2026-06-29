/**
 * dimvault.js — the IndexedDB → Vault adapter.
 *
 * loadVault(source) reads DIM's cached data and returns a plain Vault VALUE
 * (no module globals, no DOM). The only thing it touches is an injected `source`
 * with two methods, so it's pure over that interface:
 *
 *   source.allKeys(): Promise<string[]>      // every key in DIM's keyval store
 *   source.get(key):  Promise<any>           // the value at one key
 *
 * That seam is the whole point: in the page the source wraps DIM's real
 * `keyval-store` IndexedDB (content.js's openKeyvalSource); in tests it wraps a
 * tiny hand-built Map (dimvault.test.js). Two real adapters, so loadVault is
 * testable against captured fixtures without a multi-megabyte manifest.
 *
 * Loaded as a content script (exposes globalThis.VaultAdvisor.loadVault); the
 * CommonJS tail lets node:test require it directly. See CONTEXT.md for vocabulary.
 */
(function (root) {
  "use strict";

  // Name keys come from naming.js — required directly in Node, read off the shared
  // global in the browser (naming.js loads first).
  const naming = (typeof require === "function" ? require("./naming.js") : root.VaultAdvisor) || {};
  const { perkKey, iconBase } = naming;

  function emptyVault() {
    return {
      ready: false,
      error: null,
      /** instanceId -> Bungie item entry */
      byInstance: new Map(),
      /** hash -> trimmed InventoryItem def (only owned + plug hashes) */
      defs: new Map(),
      /** instanceId -> [plugHash, ...] currently socketed (visible, enabled) */
      socketsByInstance: new Map(),
      /** instanceId -> [plugHash, ...] every SELECTABLE perk across sockets */
      selectableByInstance: new Map(),
      /** icon basename -> Set<perkKey'd name> — matches DIM's icon-only plug circles */
      perkNameByIcon: new Map(),
      /** instanceId -> { tag, notes } — DIM annotations (drives the protect skip-list) */
      annotationByInstance: new Map(),
    };
  }

  /**
   * loadVault(source) → Promise<Vault>
   *
   * Builds the in-memory index content.js renders from. Throws (with a
   * user-facing message) when the cache isn't ready yet. Does NOT open or close
   * the IndexedDB — lifecycle belongs to the caller's source adapter.
   */
  async function loadVault(source) {
    const vault = emptyVault();
    const keys = await source.allKeys();
    const profileKeys = keys.filter((k) => k.startsWith("profile-"));
    if (!profileKeys.length) throw new Error("No cached profile — let DIM finish loading once.");

    // Gather every instanced item + its sockets, and the hashes we'll need to resolve.
    const neededHashes = new Set();
    for (const pk of profileKeys) {
      const profile = await source.get(pk);
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
    const bigTable = await source.get(itemDefKey);
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

    // DIM's own tags/notes, cached in the dim-api-profile blob (separate from Bungie's
    // profile-* keys). Shape: { profiles: { "<membershipId>-d2": { tags: { "<id>":
    // { id, tag, notes } } } } }. The `id` is the itemInstanceId — joins straight to
    // byInstance. We surface raw annotations; WHICH tags/notes count as "protected" is
    // user policy and lives in the caller (content.js), next to the scoring call.
    const dimApi = await source.get("dim-api-profile");
    const profiles = dimApi?.profiles || {};
    for (const profKey in profiles) {
      const tags = profiles[profKey]?.tags || {};
      for (const id in tags) {
        const a = tags[id];
        if (!a || (!a.tag && !a.notes)) continue;
        vault.annotationByInstance.set(String(id), { tag: a.tag || null, notes: a.notes || null });
      }
    }

    vault.ready = true;
    return vault;
  }

  const api = { loadVault, emptyVault };
  root.VaultAdvisor = Object.assign(root.VaultAdvisor || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
