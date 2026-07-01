"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeName, looseName, perkKey, iconBase, buildSetResolver } = require("./naming.js");

// --- buildSetResolver (armor set-name matching) ---------------------------
// Fixtures mirror the real data: the sheet keys entries by normalizeName(decorated
// Set name), each carrying two independent bonus grades; the manifest gives clean names.
const setEntry = (name, twoTier, fourTier) => ({
  name,
  category: "Set Bonus",
  twoPc: { tier: twoTier, bonus: `${name} 2pc` },
  fourPc: { tier: fourTier, bonus: `${name} 4pc` },
});
const sheetMap = (entries) => Object.fromEntries(entries.map((e) => [normalizeName(e.name), e]));

test("normalizeName strips accents, unifies apostrophes, lowercases, collapses space", () => {
  assert.equal(normalizeName("  The   Càlus  Mini-Tool "), "the calus mini-tool");
  // Curly apostrophe and backtick both fold to a straight one.
  assert.equal(normalizeName("Eyasluna’s"), normalizeName("Eyasluna's"));
  assert.equal(normalizeName("Dragon`s Breath"), "dragon's breath");
});

test("looseName drops all non-alphanumerics (punctuation/spacing-insensitive)", () => {
  assert.equal(looseName("Wish-Keeper"), looseName("Wish Keeper"));
  assert.equal(looseName("Doctrine of Passing"), "doctrineofpassing");
});

test("perkKey drops the Enhanced qualifier so enhanced perks match base recommendations", () => {
  assert.equal(perkKey("Enhanced Chill Clip"), "chill clip");
  assert.equal(perkKey("Chill Clip"), perkKey("Enhanced Chill Clip"));
  assert.equal(perkKey("  KILL  Clip "), "kill clip");
});

test("iconBase returns the trailing filename and drops any query string", () => {
  assert.equal(iconBase("/common/destiny2_content/icons/abc123.jpg"), "abc123.jpg");
  assert.equal(iconBase("https://www.bungie.net/x/y/chill.png?v=2"), "chill.png");
  assert.equal(iconBase(""), "");
});

test("buildSetResolver bridges the sheet's source-decorated Set names to clean manifest names", () => {
  // The four decorated examples from issue 05 — the sheet appends the source/activity.
  const sheet = sheetMap([
    setEntry("TM Custom Spire of the Watcher", "B", "S"),
    setEntry("Exodus Down Nessus", "C", "B"),
    setEntry("Legacy's Oath Deep Stone Crypt", "A", "A"),
    setEntry("Techeun's Regalia Shattered Throne", "S", "C"),
  ]);
  const r = buildSetResolver(sheet, [
    "Spire of the Watcher",
    "Exodus Down",
    "Legacy's Oath",
    "Techeun's Regalia",
  ]);
  assert.equal(r.resolve("Spire of the Watcher").name, "TM Custom Spire of the Watcher");
  assert.equal(r.resolve("Exodus Down").twoPc.tier, "C");
  assert.equal(r.resolve("Legacy's Oath").name, "Legacy's Oath Deep Stone Crypt");
  assert.equal(r.resolve("Techeun's Regalia").fourPc.tier, "C");
  assert.deepEqual(r.misses, []);
  assert.deepEqual(r.unmatchedSheet, []);
});

test("buildSetResolver: longest manifest name wins so a short set can't shadow a longer one", () => {
  // Both "Iron" and "Iron Will" are owned; each decorated sheet name contains "iron".
  const sheet = sheetMap([
    setEntry("Iron Will Crucible", "S", "S"),
    setEntry("Iron Banner Comp", "A", "A"),
  ]);
  const r = buildSetResolver(sheet, ["Iron", "Iron Will"]);
  assert.equal(r.resolve("Iron Will").name, "Iron Will Crucible");
  // "Iron" must NOT grab the Iron Will entry (shadowed by the longer match); it takes the
  // one the longer name can't claim.
  assert.equal(r.resolve("Iron").name, "Iron Banner Comp");
  assert.deepEqual(r.misses, []);
});

test("buildSetResolver: drops the manifest's trailing 'Set' suffix so newer set names match", () => {
  // The manifest suffixes some (newer, Armor 3.0) set names with a bare "Set" —
  // "Iron Panoply Set" — while the sheet uses the clean "Iron Panoply". Observed live.
  const sheet = sheetMap([
    setEntry("Iron Panoply Iron Banner", "A", "B"),
    setEntry("Disaster Corps Crucible", "C", "C"),
  ]);
  const r = buildSetResolver(sheet, ["Iron Panoply Set", "Disaster Corps Set"]);
  assert.equal(r.resolve("Iron Panoply Set").twoPc.tier, "A");
  assert.equal(r.resolve("Disaster Corps Set").fourPc.tier, "C");
  assert.deepEqual(r.misses, []);
});

test("buildSetResolver: token-boundary match, not raw substring", () => {
  // "oath" is a whole token in the sheet name, not a slice of "oathkeeper".
  const sheet = sheetMap([setEntry("Oathkeeper's Vow Trials", "B", "B")]);
  const r = buildSetResolver(sheet, ["Oath"]);
  assert.equal(r.resolve("Oath"), null);
  assert.deepEqual(r.misses, ["Oath"]);
});

test("buildSetResolver reports misses and never throws on unmatched or empty input", () => {
  const sheet = sheetMap([setEntry("Exodus Down Nessus", "C", "B")]);
  const r = buildSetResolver(sheet, ["Unknown Set", "Exodus Down"]);
  assert.equal(r.resolve("Exodus Down").name, "Exodus Down Nessus");
  assert.equal(r.resolve("Unknown Set"), null); // owned but not on the sheet
  assert.deepEqual(r.misses, ["Unknown Set"]);
  // Names outside the manifest, and empty/nullish names, resolve to null without crashing.
  assert.equal(r.resolve("Nonexistent"), null);
  assert.equal(r.resolve(""), null);
  assert.equal(r.resolve(null), null);
  // Degenerate inputs.
  assert.doesNotThrow(() => buildSetResolver(null, null));
  assert.equal(buildSetResolver({}, []).resolve("anything"), null);
});

test("buildSetResolver: an explicit alias bridges a name no rule can reach", () => {
  // Irreducible: the sheet's decorated name shares no tokens with the clean manifest name.
  const sheet = sheetMap([setEntry("TM Custom Kell's Vengeance", "B", "D")]);
  const aliases = { [normalizeName("Last Discipline")]: normalizeName("TM Custom Kell's Vengeance") };
  const r = buildSetResolver(sheet, ["Last Discipline"], aliases);
  assert.equal(r.resolve("Last Discipline").fourPc.tier, "D");
  assert.deepEqual(r.misses, []);
});

test("buildSetResolver surfaces sheet sets that match no owned armor", () => {
  const sheet = sheetMap([
    setEntry("Exodus Down Nessus", "C", "B"),
    setEntry("Vex Filigree Sundial", "A", "A"),
  ]);
  const r = buildSetResolver(sheet, ["Exodus Down"]);
  assert.equal(r.resolve("Exodus Down").name, "Exodus Down Nessus");
  assert.deepEqual(r.unmatchedSheet, ["Vex Filigree Sundial"]);
});
