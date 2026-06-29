"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildWishlist, buildLookups } = require("./wishlist.js");

// --- manifest fixtures (shaped like the real tables, confirmed via DIM's IndexedDB) -------
// Two reissues of "The Martlet": #1 rolls Demolitionist/Rimestealer in perk1 (set 100) and
// Chill Clip in perk2 (set 101); reissue #2 only rolls Demolitionist in perk1 (set 102).
// Each trait has a base and an Enhanced twin sharing the NAME — only itemTypeDisplayName differs.
const ITEMS = {
  1: { hash: 1, itemCategoryHashes: [1], displayProperties: { name: "The Martlet" },
       sockets: { socketEntries: [{ randomizedPlugSetHash: 100 }, { randomizedPlugSetHash: 101 }] } },
  2: { hash: 2, itemCategoryHashes: [1], displayProperties: { name: "The Martlet" },
       sockets: { socketEntries: [{ randomizedPlugSetHash: 102 }, { randomizedPlugSetHash: 101 }] } },
  11: { hash: 11, plug: {}, itemTypeDisplayName: "Trait", displayProperties: { name: "Demolitionist" } },
  12: { hash: 12, plug: {}, itemTypeDisplayName: "Enhanced Trait", displayProperties: { name: "Demolitionist" } },
  13: { hash: 13, plug: {}, itemTypeDisplayName: "Trait", displayProperties: { name: "Rimestealer" } },
  21: { hash: 21, plug: {}, itemTypeDisplayName: "Trait", displayProperties: { name: "Chill Clip" } },
  22: { hash: 22, plug: {}, itemTypeDisplayName: "Enhanced Trait", displayProperties: { name: "Chill Clip" } },
  // A ghost mod that shares the name "Demolitionist" — must never be cited (not in any weapon set).
  99: { hash: 99, plug: {}, itemTypeDisplayName: "Economic Ghost Mod", displayProperties: { name: "Demolitionist" } },
  // A retired option (currentlyCanRoll:false) — must be dropped.
  14: { hash: 14, plug: {}, itemTypeDisplayName: "Trait", displayProperties: { name: "Frenzy" } },
};
const PLUGSETS = {
  100: { reusablePlugItems: [
    { plugItemHash: 11, currentlyCanRoll: true }, { plugItemHash: 12, currentlyCanRoll: true },
    { plugItemHash: 13, currentlyCanRoll: true }, { plugItemHash: 14, currentlyCanRoll: false }, // retired
  ] },
  101: { reusablePlugItems: [{ plugItemHash: 21, currentlyCanRoll: true }, { plugItemHash: 22, currentlyCanRoll: true }] },
  102: { reusablePlugItems: [{ plugItemHash: 11, currentlyCanRoll: true }] },
};

const lookups = () => buildLookups(ITEMS, PLUGSETS);
const wishLines = (text) => text.split("\n").filter((l) => l.startsWith("dimwishlist:"));

// --- buildLookups: per-weapon plug resolution ------------------------------

test("weaponHashes groups every same-named weapon (reissues)", () => {
  assert.deepEqual(lookups().weaponHashes("the martlet").sort(), [1, 2]);
  assert.deepEqual(lookups().weaponHashes("unknown gun"), []);
});

test("weaponPlugs returns only the NON-enhanced perks a weapon actually rolls", () => {
  const m = lookups().weaponPlugs(1);
  assert.equal(m.get("demolitionist"), 11); // base, not the enhanced 12
  assert.equal(m.get("rimestealer"), 13);
  assert.equal(m.get("chill clip"), 21); // base, not the enhanced 22
  assert.equal(m.has("frenzy"), false); // currentlyCanRoll:false → dropped
  assert.equal(m.size, 3);
});

test("weaponHashes falls back to the loose (alphanumeric-only) name on punctuation drift", () => {
  // Manifest "The Martlet"; a sheet that wrote "the-martlet!" still resolves via the loose key.
  const wh = lookups().weaponHashes;
  assert.deepEqual(wh("the-martlet!").sort(), [1, 2]);
  assert.deepEqual(wh("totally unknown"), []);
});

test("redacted plug defs are never cited", () => {
  const ITEMS2 = {
    1: { hash: 1, itemCategoryHashes: [1], displayProperties: { name: "Gun" },
         sockets: { socketEntries: [{ randomizedPlugSetHash: 10 }, { randomizedPlugSetHash: 11 }] } },
    100: { hash: 100, plug: {}, itemTypeDisplayName: "Trait", displayProperties: { name: "T1" } },
    101: { hash: 101, plug: {}, itemTypeDisplayName: "Trait", displayProperties: { name: "T2" } },
    102: { hash: 102, redacted: true, plug: {}, itemTypeDisplayName: "Trait", displayProperties: { name: "T1" } },
  };
  const PS2 = {
    10: { reusablePlugItems: [{ plugItemHash: 100, currentlyCanRoll: true }, { plugItemHash: 102, currentlyCanRoll: true }] },
    11: { reusablePlugItems: [{ plugItemHash: 101, currentlyCanRoll: true }] },
  };
  const m = buildLookups(ITEMS2, PS2).weaponPlugs(1);
  assert.equal(m.get("t1"), 100); // the live def, not the redacted 102
  assert.equal(m.size, 2);
});

test("a name shared with a non-weapon plug (ghost mod) is never resolved", () => {
  // 99 ("Demolitionist" ghost mod) isn't in any weapon's plug set, so it can't be cited.
  const m = lookups().weaponPlugs(1);
  assert.equal(m.get("demolitionist"), 11);
  assert.notEqual(m.get("demolitionist"), 99);
});

// --- buildWishlist: valid, non-enhanced lines only -------------------------

test("emits one line per (resolvable) trait combo, per reissue, base hashes only", () => {
  const { text, stats } = buildWishlist(
    [{ name: "The Martlet", tier: "S", perks: { perk1: ["Demolitionist", "Rimestealer"], perk2: ["Chill Clip"] } }],
    lookups(),
  );
  const lines = wishLines(text);
  // item 1 rolls both perk1 traits → 11,21 and 13,21. item 2 rolls only Demolitionist → 11,21.
  assert.deepEqual(lines.sort(), [
    "dimwishlist:item=1&perks=11,21",
    "dimwishlist:item=1&perks=13,21",
    "dimwishlist:item=2&perks=11,21",
  ].sort());
  // No enhanced hashes (12, 22) anywhere.
  assert.equal(text.includes("12"), false);
  assert.equal(text.includes("22"), false);
  assert.equal(stats.weapons, 1);
  assert.equal(stats.lines, 3);
  assert.deepEqual(stats.unmatchedPerks, []);
});

test("mode controls how barrel/mag factor in (traits vs full)", () => {
  // A weapon with one trait per column plus a barrel socket and a mag socket.
  const ITEMS2 = {
    1: { hash: 1, itemCategoryHashes: [1], displayProperties: { name: "Gun" },
         sockets: { socketEntries: [{ randomizedPlugSetHash: 10 }, { randomizedPlugSetHash: 11 }, { randomizedPlugSetHash: 12 }, { randomizedPlugSetHash: 13 }] } },
    100: { hash: 100, plug: {}, itemTypeDisplayName: "Trait", displayProperties: { name: "T1" } },
    101: { hash: 101, plug: {}, itemTypeDisplayName: "Trait", displayProperties: { name: "T2" } },
    200: { hash: 200, plug: {}, itemTypeDisplayName: "Barrel", displayProperties: { name: "Bar1" } },
    300: { hash: 300, plug: {}, itemTypeDisplayName: "Magazine", displayProperties: { name: "Mag1" } },
  };
  const PS2 = {
    10: { reusablePlugItems: [{ plugItemHash: 100, currentlyCanRoll: true }] },
    11: { reusablePlugItems: [{ plugItemHash: 101, currentlyCanRoll: true }] },
    12: { reusablePlugItems: [{ plugItemHash: 200, currentlyCanRoll: true }] },
    13: { reusablePlugItems: [{ plugItemHash: 300, currentlyCanRoll: true }] },
  };
  const lk = buildLookups(ITEMS2, PS2);
  const entry = { name: "Gun", tier: "S", perks: { perk1: ["T1"], perk2: ["T2"], barrel: ["Bar1"], mag: ["Mag1"] } };

  assert.deepEqual(wishLines(buildWishlist([entry], lk, "traits").text), ["dimwishlist:item=1&perks=100,101"]);
  // Full mode = the complete roll on one line, so DIM highlights barrel + mag too.
  assert.deepEqual(wishLines(buildWishlist([entry], lk, "full").text), ["dimwishlist:item=1&perks=100,101,200,300"]);
});

test("each weapon gets a // name + //notes:Tier block", () => {
  const { text } = buildWishlist(
    [{ name: "The Martlet", tier: "S", notes: "PVE\nS", perks: { perk1: ["Demolitionist"], perk2: ["Chill Clip"] } }],
    lookups(),
  );
  assert.ok(text.includes("// The Martlet"));
  assert.ok(text.includes("//notes:Tier S. PVE S"));
});

test("a header comment leads the file", () => {
  assert.ok(buildWishlist([], lookups()).text.split("\n")[0].startsWith("// Vault Advisor"));
});

test("a row missing a trait column is skipped (no roll to express)", () => {
  const { stats } = buildWishlist(
    [{ name: "The Martlet", tier: "S", perks: { perk1: ["Demolitionist"], perk2: [] } }],
    lookups(),
  );
  assert.equal(stats.weapons, 0);
  assert.deepEqual(stats.unmatchedWeapons, []);
});

test("a weapon whose name resolves to no item is reported", () => {
  const { stats } = buildWishlist(
    [{ name: "Ghost Gun", tier: "A", perks: { perk1: ["Demolitionist"], perk2: ["Chill Clip"] } }],
    lookups(),
  );
  assert.equal(stats.weapons, 0);
  assert.deepEqual(stats.unmatchedWeapons, ["Ghost Gun"]);
});

test("a perk name that resolves on NO weapon is flagged as drift; a weapon with no rollable combo is unmatched", () => {
  const { stats } = buildWishlist(
    [{ name: "The Martlet", tier: "S", perks: { perk1: ["Frenzy"], perk2: ["Chill Clip"] } }],
    lookups(),
  );
  // Frenzy is retired on this weapon (currentlyCanRoll:false) and rolls nowhere → drift.
  assert.ok(stats.unmatchedPerks.includes("Frenzy"));
  // perk1 had nothing rollable → no lines → weapon reported.
  assert.deepEqual(stats.unmatchedWeapons, ["The Martlet"]);
  assert.equal(stats.weapons, 0);
});

test("identical lines are de-duped within a weapon", () => {
  const { stats } = buildWishlist(
    // Both perk1 options resolve to the same hash on item 2 (only Demolitionist) → one line, not two.
    [{ name: "The Martlet", tier: "S", perks: { perk1: ["Demolitionist", "Demolitionist"], perk2: ["Chill Clip"] } }],
    lookups(),
  );
  // item 1: 11,21 ; item 2: 11,21 — distinct items, both kept; the within-weapon dup is collapsed.
  assert.equal(stats.lines, 2);
});
