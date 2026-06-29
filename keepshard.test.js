"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { rankGroup } = require("./keepshard.js");

// A representative T5-style recommendation: two trait columns with options, plus
// secondary barrel/mag. Mirrors the sheet's perk object shape.
const REC = {
  perk1: ["Demolitionist", "Rimestealer"],
  perk2: ["Chill Clip", "Frenzy"],
  barrel: ["Arrowhead Brake"],
  mag: ["Accurized Rounds"],
};

// copy(id, selectablePerkNames, { mw, protected })
const copy = (id, selectable, opts = {}) => ({
  id,
  selectable,
  masterwork: Boolean(opts.mw),
  protected: Boolean(opts.protected),
});

const roleOf = (v, id) => v.copies.find((c) => c.id === id).role;
const entry = (v, id) => v.copies.find((c) => c.id === id);

// --- groups that should not produce any coloring ---------------------------

test("singleton group → null (no keep/shard decision)", () => {
  assert.equal(rankGroup([copy("a", ["Demolitionist", "Chill Clip"])], REC, {}), null);
});

test("no recommended perks → null", () => {
  const empty = { perk1: [], perk2: [], barrel: [], mag: [] };
  assert.equal(rankGroup([copy("a", ["Demolitionist"]), copy("b", ["Frenzy"])], empty, {}), null);
});

test("no copy hits a recommended trait → null (barrel-only does not color a group)", () => {
  const v = rankGroup(
    [copy("a", ["Arrowhead Brake"]), copy("b", ["Accurized Rounds"])],
    REC,
    { keepCoverage: true },
  );
  assert.equal(v, null);
});

// --- core keep / shard -----------------------------------------------------

test("clear keeper vs shard: traits beat nothing", () => {
  const v = rankGroup(
    [copy("best", ["Demolitionist", "Chill Clip"]), copy("junk", ["Arrowhead Brake"])],
    REC,
    { keepCoverage: true },
  );
  assert.deepEqual(v.keepers, ["best"]);
  assert.equal(roleOf(v, "best"), "keeper");
  assert.equal(roleOf(v, "junk"), "shard");
  assert.equal(v.total, 2);
});

// A god roll presents EVERY recommended trait option in both columns + a barrel + a mag.
const PERFECT = ["Demolitionist", "Rimestealer", "Chill Clip", "Frenzy", "Arrowhead Brake", "Accurized Rounds"];

test("god roll = every recommended trait option in both columns, plus a barrel and a mag", () => {
  const v = rankGroup([copy("perfect", PERFECT), copy("x", ["Arrowhead Brake"])], REC, {});
  assert.equal(entry(v, "perfect").godRoll, true);
  assert.deepEqual(v.keepers, ["perfect"]);
});

test("almost-perfect (missing one trait option) is NOT a god roll, but still the keeper", () => {
  // both perk2 options + barrel + mag + only ONE perk1 (lacks Rimestealer) → not perfect.
  const almost = ["Demolitionist", "Chill Clip", "Frenzy", "Arrowhead Brake", "Accurized Rounds"];
  const v = rankGroup([copy("a", almost), copy("x", ["Arrowhead Brake"])], REC, {});
  assert.equal(entry(v, "a").godRoll, false);
  assert.equal(roleOf(v, "a"), "keeper");
});

test("full traits but no barrel/mag is NOT a god roll", () => {
  const v = rankGroup(
    [copy("g", ["Demolitionist", "Rimestealer", "Chill Clip", "Frenzy"]), copy("x", ["Arrowhead Brake"])],
    REC,
    {},
  );
  assert.equal(entry(v, "g").godRoll, false);
});

// --- coverage (yellow) -----------------------------------------------------

test("two different full god rolls tie → both are keepers (co-equal bests)", () => {
  // Both hit both trait columns; they only differ in WHICH perk1 trait. Neither
  // dominates, so both are green — keep both builds or bin either, your call.
  const v = rankGroup(
    [
      copy("demo", ["Demolitionist", "Chill Clip"]),
      copy("rime", ["Rimestealer", "Chill Clip"]),
    ],
    REC,
    { keepCoverage: true },
  );
  assert.deepEqual(v.keepers.sort(), ["demo", "rime"]);
});

test("coverage on: a strictly-worse copy filling a trait gap is yellow", () => {
  // keeper is a full god roll (Demolitionist+Chill Clip); the partial copy only rolls
  // Rimestealer — strictly worse, but it's a perk1 trait the keeper can't present → coverage.
  const v = rankGroup(
    [
      copy("keep", ["Demolitionist", "Chill Clip"]),
      copy("rime", ["Rimestealer"]),
    ],
    REC,
    { keepCoverage: true },
  );
  assert.deepEqual(v.keepers, ["keep"]);
  assert.equal(roleOf(v, "rime"), "coverage");
  assert.deepEqual(entry(v, "rime").unique, ["Rimestealer"]);
});

test("coverage off: the same gap-filling copy becomes shard", () => {
  const v = rankGroup(
    [
      copy("keep", ["Demolitionist", "Chill Clip"]),
      copy("rime", ["Rimestealer"]),
    ],
    REC,
    { keepCoverage: false },
  );
  assert.equal(roleOf(v, "rime"), "shard");
});

test("dominated duplicate is shard, not coverage (adds no new trait)", () => {
  // 'sub' traits are a subset of the keeper's → contributes nothing → shard even with coverage on.
  const v = rankGroup(
    [
      copy("keep", ["Demolitionist", "Chill Clip"]),
      copy("sub", ["Demolitionist"]),
    ],
    REC,
    { keepCoverage: true },
  );
  assert.equal(roleOf(v, "keep"), "keeper");
  assert.equal(roleOf(v, "sub"), "shard");
});

test("two copies bringing the SAME missing trait: one covers, the other shards", () => {
  // keeper lacks Rimestealer; both partial copies 'r1'/'r2' bring only it. One copy
  // preserves the trait → the better one (masterworked) is coverage, the other shards.
  const v = rankGroup(
    [
      copy("keep", ["Demolitionist", "Chill Clip"]),
      copy("r1", ["Rimestealer"], { mw: true }),
      copy("r2", ["Rimestealer"]),
    ],
    REC,
    { keepCoverage: true },
  );
  assert.equal(roleOf(v, "keep"), "keeper");
  assert.equal(roleOf(v, "r1"), "coverage"); // masterwork → better, gets the keep call
  assert.equal(roleOf(v, "r2"), "shard");
});

// --- tiebreaks -------------------------------------------------------------

test("exact tie for best → all tied copies are keepers", () => {
  const v = rankGroup(
    [
      copy("a", ["Demolitionist", "Chill Clip"]),
      copy("b", ["Demolitionist", "Chill Clip"]),
    ],
    REC,
    { keepCoverage: true },
  );
  assert.deepEqual(v.keepers.sort(), ["a", "b"]);
  assert.equal(roleOf(v, "a"), "keeper");
  assert.equal(roleOf(v, "b"), "keeper");
});

test("depth breaks a tie below trait coverage (more switchable options wins)", () => {
  // Both hit both traits (perkScore equal). 'deep' can also switch to Rimestealer in
  // perk1 → higher depth → sole keeper; 'flat' covers no new trait → shard.
  const v = rankGroup(
    [
      copy("deep", ["Demolitionist", "Rimestealer", "Chill Clip"]),
      copy("flat", ["Demolitionist", "Chill Clip"]),
    ],
    REC,
    { keepCoverage: true },
  );
  assert.deepEqual(v.keepers, ["deep"]);
  assert.equal(roleOf(v, "flat"), "shard");
});

test("masterwork breaks an otherwise exact tie", () => {
  const v = rankGroup(
    [
      copy("mw", ["Demolitionist", "Chill Clip"], { mw: true }),
      copy("plain", ["Demolitionist", "Chill Clip"]),
    ],
    REC,
    { keepCoverage: true },
  );
  assert.deepEqual(v.keepers, ["mw"]);
  assert.equal(roleOf(v, "plain"), "shard");
});

// --- protected -------------------------------------------------------------

test("protected copy is never sharded and never scored", () => {
  const v = rankGroup(
    [
      copy("best", ["Demolitionist", "Chill Clip"]),
      copy("junk", ["Arrowhead Brake"]),
      copy("pvp", ["Frenzy"], { protected: true }),
    ],
    REC,
    { keepCoverage: true },
  );
  assert.deepEqual(v.keepers, ["best"]);
  assert.equal(roleOf(v, "junk"), "shard");
  assert.equal(roleOf(v, "pvp"), "protected");
  assert.equal(v.total, 3);
});

test("a string `protected` rides through to the entry as protectedReason", () => {
  const v = rankGroup(
    [
      { id: "best", selectable: ["Demolitionist", "Chill Clip"], masterwork: false, protected: false },
      { id: "junk", selectable: ["Arrowhead Brake"], masterwork: false, protected: false },
      { id: "pvp", selectable: ["Frenzy"], masterwork: false, protected: 'DIM "keep" tag' },
    ],
    REC,
    { keepCoverage: true },
  );
  assert.equal(roleOf(v, "pvp"), "protected");
  assert.equal(entry(v, "pvp").protectedReason, 'DIM "keep" tag');
  // A boolean-protected copy has no reason string.
  assert.equal(entry(v, "junk").protectedReason, undefined); // not protected → field absent
});

test("a protected copy does not become the keeper even if it is the best roll", () => {
  // The protected god roll is set aside (never a keeper), and the lone active copy can't be
  // compared — so there's no keep/shard call. But the protected copy is still MARKED protected.
  const v = rankGroup(
    [
      copy("pvp", ["Demolitionist", "Chill Clip"], { protected: true }),
      copy("only", ["Demolitionist"]),
    ],
    REC,
    { keepCoverage: true },
  );
  assert.deepEqual(v.keepers, []);
  assert.equal(roleOf(v, "pvp"), "protected");
  assert.equal(v.copies.find((c) => c.id === "only"), undefined); // lone active copy: no verdict
});

test("a protected copy in a 2-copy group is still shown (no keep/shard call, but a marker)", () => {
  // The common case: two copies, you tag one 'keep'. There's nothing to shard, but the tagged
  // copy must still surface its protected badge rather than the whole group going dark.
  const v = rankGroup(
    [
      copy("keepme", ["Demolitionist", "Chill Clip"], { protected: true }),
      copy("plain", ["Demolitionist", "Chill Clip"]),
    ],
    REC,
    {},
  );
  assert.deepEqual(v.keepers, []);
  assert.equal(roleOf(v, "keepme"), "protected");
  assert.equal(v.total, 2);
});

test("no protected copies + nothing to advise → still null", () => {
  // The guard only emits a verdict when there's something to show (a protected marker).
  assert.equal(rankGroup([copy("a", ["Demolitionist", "Chill Clip"])], REC, {}), null); // singleton
  assert.equal(
    rankGroup([copy("a", ["Arrowhead Brake"]), copy("b", ["Accurized Rounds"])], REC, {}),
    null, // two copies, neither hits a trait
  );
});
