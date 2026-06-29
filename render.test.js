"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { tileKind, badgeClass, verdictLines, recommendedTiers, glowTier, redundantQuery } = require("./render.js");

// --- tileKind --------------------------------------------------------------

test("tileKind maps each role to its outline kind; godRoll keeper is purple", () => {
  assert.equal(tileKind({ role: "keeper", godRoll: false }), "keep");
  assert.equal(tileKind({ role: "keeper", godRoll: true }), "godroll");
  assert.equal(tileKind({ role: "coverage" }), "coverage");
  assert.equal(tileKind({ role: "shard" }), "shard");
  assert.equal(tileKind({ role: "protected" }), null); // protected → no outline
  assert.equal(tileKind(null), null);
});

// --- badgeClass ------------------------------------------------------------

test("badgeClass picks the ring class; godRoll beats a plain keeper", () => {
  assert.equal(badgeClass({ role: "keeper", godRoll: true }), "va-godroll");
  assert.equal(badgeClass({ role: "keeper", godRoll: false }), "va-keep");
  assert.equal(badgeClass({ role: "coverage" }), "va-coverage");
  assert.equal(badgeClass({ role: "shard" }), "va-redundant");
  assert.equal(badgeClass({ role: "protected" }), "va-protected");
  assert.equal(badgeClass({ role: null }), "");
  assert.equal(badgeClass(null), "");
});

// --- verdictLines ----------------------------------------------------------

test("verdictLines: keeper variants (god roll / best roll / best of copies)", () => {
  assert.equal(verdictLines({ role: "keeper", godRoll: true }).verdict, "★ Keep — god roll (every recommended perk)");
  assert.equal(verdictLines({ role: "keeper", hits: ["Demolitionist", "Chill Clip"] }).verdict, "✓ Keep — best roll: Demolitionist + Chill Clip");
  assert.equal(verdictLines({ role: "keeper", hits: [] }).verdict, "✓ Keep — best of your copies");
});

test("verdictLines: coverage names the unique trait", () => {
  assert.equal(verdictLines({ role: "coverage", unique: ["Rimestealer"] }).verdict, "◆ Your call — only copy that can roll Rimestealer");
});

test("verdictLines: protected shows the reason, with a fallback", () => {
  assert.equal(verdictLines({ role: "protected", protectedReason: 'DIM "keep" tag' }).verdict, '🔒 Protected — DIM "keep" tag');
  assert.equal(verdictLines({ role: "protected" }).verdict, "🔒 Protected — excluded from keep/shard");
});

test("verdictLines: shard why-line is depth when traits tie, else masterwork", () => {
  const sameTraits = { role: "shard", total: 3, hits: ["Demolitionist"], keeperHits: ["Demolitionist"], depth: 1, keeperDepth: 3 };
  assert.equal(verdictLines(sameTraits).verdict, "⚠ Shard — you own a better copy (3 total)");
  assert.equal(verdictLines(sameTraits).why, "· keeper has more recommended perks to switch between (3 vs 1)");

  // Traits and depth tie → the keeper won on barrel/mag or masterwork; we don't carry which,
  // so the line must not assert a specific (possibly false) cause.
  const tiedDepth = { role: "shard", total: 2, hits: ["Demolitionist"], keeperHits: ["Demolitionist"], depth: 2, keeperDepth: 2 };
  assert.equal(verdictLines(tiedDepth).why, "· keeper edges it on barrel/mag or masterwork");
});

test("verdictLines: shard why-line contrasts traits when they differ", () => {
  const diff = { role: "shard", total: 2, hits: ["Rimestealer"], keeperHits: ["Demolitionist", "Chill Clip"] };
  assert.equal(verdictLines(diff).why, "· keeper rolls Demolitionist + Chill Clip; this rolls Rimestealer");

  const none = { role: "shard", total: 2, hits: [], keeperHits: ["Demolitionist"] };
  assert.equal(verdictLines(none).why, "· keeper rolls Demolitionist; this has none of the recommended perks");
});

test("verdictLines: no verdict → empty strings", () => {
  assert.deepEqual(verdictLines(null), { verdict: "", why: "" });
  assert.deepEqual(verdictLines({ role: null }), { verdict: "", why: "" });
});

// --- recommendedTiers / glowTier ------------------------------------------

const REC = { perk1: ["Demolitionist"], perk2: ["Chill Clip"], barrel: ["Arrowhead Brake"], mag: ["Accurized Rounds"] };

test("recommendedTiers: traits are primary, barrel/mag secondary, keyed by perkKey", () => {
  const m = recommendedTiers(REC);
  assert.equal(m.get("demolitionist"), "primary");
  assert.equal(m.get("chill clip"), "primary");
  assert.equal(m.get("arrowhead brake"), "secondary");
  assert.equal(m.get("accurized rounds"), "secondary");
  assert.equal(recommendedTiers(null).size, 0);
});

test("recommendedTiers: a trait also listed as secondary stays primary (first wins)", () => {
  const m = recommendedTiers({ perk1: ["Demolitionist"], perk2: [], barrel: ["Demolitionist"], mag: [] });
  assert.equal(m.get("demolitionist"), "primary");
});

test("glowTier: primary beats secondary; null when nothing matches or no names", () => {
  const tiers = recommendedTiers(REC);
  assert.equal(glowTier(new Set(["accurized rounds", "demolitionist"]), tiers), "primary");
  assert.equal(glowTier(new Set(["accurized rounds"]), tiers), "secondary");
  assert.equal(glowTier(new Set(["random perk"]), tiers), null);
  assert.equal(glowTier(null, tiers), null);
});

// --- redundantQuery --------------------------------------------------------

test("redundantQuery ORs names and strips embedded quotes; empty list → empty string", () => {
  assert.equal(redundantQuery(["Mint Retrograde", "Giver's Blessing"]), '(name:"Mint Retrograde" or name:"Giver\'s Blessing")');
  assert.equal(redundantQuery(['weird"name']), '(name:"weirdname")');
  assert.equal(redundantQuery([]), "");
});
