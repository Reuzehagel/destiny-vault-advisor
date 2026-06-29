"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildWishlist } = require("./wishlist.js");

// Fixture lookups — stand in for the manifest index the real generator builds.
// weaponHashes is keyed by NORMALIZED name (the module normalizes before looking up).
const WEAPONS = new Map([
  ["festival flight", [3077654124, 999]], // two reissues share the name
  ["lone wolf", [42]],
]);
const PLUGS = new Map([
  ["Demolitionist", [11]],
  ["Rimestealer", [12]],
  ["Chill Clip", [21, 22]], // base + enhanced
  ["Headstone", [31]],
  // "Frenzy" intentionally absent → an unmatchable perk
]);
const lookups = {
  weaponHashes: (n) => WEAPONS.get(n) || [],
  plugHashes: (nm) => PLUGS.get(nm) || [],
};

const lines = (text) => text.split("\n");
const wishLines = (text) => lines(text).filter((l) => l.startsWith("dimwishlist:"));

test("a roll expands to the cartesian product of both trait columns × every reissue hash", () => {
  const { text, stats } = buildWishlist(
    [{ name: "Festival Flight", tier: "S", perks: { perk1: ["Demolitionist", "Rimestealer"], perk2: ["Chill Clip"] } }],
    lookups,
  );
  // 2 item hashes × 2 perk1 hashes × 2 perk2 hashes (Chill Clip base+enhanced) = 8 lines.
  assert.equal(stats.weapons, 1);
  assert.equal(stats.lines, 8);
  assert.equal(wishLines(text).length, 8);
  // A representative line is well-formed.
  assert.ok(text.includes("dimwishlist:item=3077654124&perks=11,21"));
  assert.ok(text.includes("dimwishlist:item=999&perks=12,22"));
});

test("each weapon gets a // name + //notes:Tier block", () => {
  const { text } = buildWishlist(
    [{ name: "Festival Flight", tier: "S", notes: "Best with Dream Work\norigin", perks: { perk1: ["Demolitionist"], perk2: ["Chill Clip"] } }],
    lookups,
  );
  assert.ok(text.includes("// Festival Flight"));
  // Tier first (so wishlistnotes:S works), then the sheet note collapsed to one line.
  assert.ok(text.includes("//notes:Tier S. Best with Dream Work origin"));
});

test("a header comment leads the file", () => {
  const { text } = buildWishlist([], lookups);
  assert.ok(lines(text)[0].startsWith("// Vault Advisor"));
});

test("untiered weapon still wishlists, noted as Untiered", () => {
  const { text, stats } = buildWishlist(
    [{ name: "Lone Wolf", tier: "", perks: { perk1: ["Demolitionist"], perk2: ["Headstone"] } }],
    lookups,
  );
  assert.equal(stats.weapons, 1);
  assert.ok(text.includes("//notes:Untiered"));
});

test("a row missing a trait column is skipped (no roll to express)", () => {
  const { stats } = buildWishlist(
    [{ name: "Festival Flight", tier: "S", perks: { perk1: ["Demolitionist"], perk2: [] } }],
    lookups,
  );
  assert.equal(stats.weapons, 0);
  assert.deepEqual(stats.unmatchedWeapons, []); // not "unmatched" — just nothing to say
});

test("a weapon whose name resolves to no hash is reported, not emitted", () => {
  const { stats } = buildWishlist(
    [{ name: "Ghost Gun", tier: "A", perks: { perk1: ["Demolitionist"], perk2: ["Chill Clip"] } }],
    lookups,
  );
  assert.equal(stats.weapons, 0);
  assert.deepEqual(stats.unmatchedWeapons, ["Ghost Gun"]);
});

test("an unresolved perk is recorded; a column with no resolved perk drops the weapon", () => {
  const { stats } = buildWishlist(
    [{ name: "Festival Flight", tier: "S", perks: { perk1: ["Frenzy"], perk2: ["Chill Clip"] } }],
    lookups,
  );
  assert.equal(stats.weapons, 0);
  assert.deepEqual(stats.unmatchedWeapons, ["Festival Flight"]); // perk1 had nothing resolvable
  assert.ok(stats.unmatchedPerks.includes("Frenzy"));
});

test("identical lines are de-duped within a weapon", () => {
  // Both perk1 options resolve to the SAME hash → the product would repeat lines.
  const dupPlugs = new Map([["A", [11]], ["B", [11]], ["C", [21]]]);
  const { stats } = buildWishlist(
    [{ name: "Lone Wolf", tier: "A", perks: { perk1: ["A", "B"], perk2: ["C"] } }],
    { weaponHashes: (n) => (n === "lone wolf" ? [42] : []), plugHashes: (nm) => dupPlugs.get(nm) || [] },
  );
  assert.equal(stats.lines, 1); // item=42&perks=11,21 once, not twice
});
