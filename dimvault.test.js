"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadVault } = require("./dimvault.js");
const { iconBase } = require("./naming.js");

// A Map-backed source — the test-side adapter at the same seam content.js's real
// IndexedDB adapter implements. allKeys/get return promises, like the IDB version.
const makeSource = (entries) => {
  const map = new Map(entries);
  return {
    allKeys: async () => [...map.keys()],
    get: async (k) => map.get(k),
  };
};

// A minimal but real-shaped DIM cache: one profile with two copies of one weapon,
// a trimmed manifest, and a dim-api-profile annotations blob. Mirrors the nested
// shapes loadVault depends on (captured from a live keyval-store).
const A = "inst-A";
const B = "inst-B";
const fixture = () => [
  [
    "profile-123",
    {
      profileInventory: {
        data: { items: [{ itemInstanceId: A, itemHash: 1000 }, { itemInstanceId: B, itemHash: 1000 }] },
      },
      characterInventories: { data: {} },
      characterEquipment: { data: {} },
      itemComponents: {
        sockets: {
          data: {
            [A]: { sockets: [{ plugHash: 2001, isVisible: true, isEnabled: true }] },
            [B]: { sockets: [{ plugHash: 2002, isVisible: true, isEnabled: true }] },
          },
        },
        reusablePlugs: {
          data: {
            // Copy A is a multi-perk drop: perk1 toggles Demolitionist/Rimestealer, perk2 is Chill Clip.
            [A]: { plugs: { 0: [{ plugItemHash: 2001 }, { plugItemHash: 2002 }], 1: [{ plugItemHash: 2003 }] } },
            // Copy B is a plain roll: only the socketed perk is selectable.
            [B]: { plugs: { 0: [{ plugItemHash: 2002 }] } },
          },
        },
      },
    },
  ],
  [
    "d2-manifest-InventoryItem",
    {
      1000: { displayProperties: { name: "Test Rifle" }, inventory: { tierType: 5 } },
      2001: { plug: {}, displayProperties: { name: "Demolitionist", icon: "/common/x/demo.png" } },
      2002: { plug: {}, displayProperties: { name: "Rimestealer", icon: "/common/x/rime.png" } },
      2003: { plug: {}, displayProperties: { name: "Enhanced Chill Clip", icon: "/common/x/chill.png?v=2" } },
      // A non-plug def must be ignored by the icon index.
      9999: { displayProperties: { name: "Some Shader", icon: "/common/x/shader.png" } },
    },
  ],
  [
    "dim-api-profile",
    {
      profiles: {
        "123-d2": {
          tags: {
            [A]: { id: A, tag: "keep" },
            [B]: { id: B, tag: "junk", notes: "dismantle" },
          },
        },
      },
    },
  ],
];

test("loadVault indexes every instanced copy and resolves its def", async () => {
  const v = await loadVault(makeSource(fixture()));
  assert.equal(v.ready, true);
  assert.deepEqual([...v.byInstance.keys()].sort(), [A, B]);
  assert.equal(v.defs.get(1000).displayProperties.name, "Test Rifle");
});

test("socketed vs selectable: A unions its togglable perks, B is just its rolled perk", async () => {
  const v = await loadVault(makeSource(fixture()));
  assert.deepEqual(v.socketsByInstance.get(A), [2001]);
  assert.deepEqual(v.selectableByInstance.get(A).sort(), [2001, 2002, 2003]);
  assert.deepEqual(v.selectableByInstance.get(B), [2002]);
});

test("perkNameByIcon maps icon basename -> perkKey'd names, skipping non-plug defs", async () => {
  const v = await loadVault(makeSource(fixture()));
  // Enhanced qualifier is stripped and the ?v= query is dropped from the icon name.
  assert.deepEqual([...v.perkNameByIcon.get("chill.png")], ["chill clip"]);
  assert.deepEqual([...v.perkNameByIcon.get("demo.png")], ["demolitionist"]);
  assert.equal(v.perkNameByIcon.has("shader.png"), false); // not a plug → not indexed
  assert.equal(iconBase("/common/x/chill.png?v=2"), "chill.png");
});

test("annotationByInstance surfaces DIM tags and notes, keyed by instanceId", async () => {
  const v = await loadVault(makeSource(fixture()));
  assert.deepEqual(v.annotationByInstance.get(A), { tag: "keep", notes: null });
  assert.deepEqual(v.annotationByInstance.get(B), { tag: "junk", notes: "dismantle" });
});

test("no cached profile → throws a user-facing message", async () => {
  await assert.rejects(
    loadVault(makeSource([["d2-manifest-InventoryItem", {}]])),
    /No cached profile/,
  );
});

test("missing InventoryItem table → throws", async () => {
  await assert.rejects(
    loadVault(makeSource([["profile-123", { profileInventory: { data: { items: [] } } }]])),
    /InventoryItem manifest table not cached/,
  );
});

test("absent dim-api-profile is fine — annotations are just empty", async () => {
  const entries = fixture().filter(([k]) => k !== "dim-api-profile");
  const v = await loadVault(makeSource(entries));
  assert.equal(v.annotationByInstance.size, 0);
});
