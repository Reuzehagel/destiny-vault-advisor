"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseCSV, buildFromTab, buildSetBonusesFromTab } = require("./sheet.js");

// --- parseCSV --------------------------------------------------------------

test("parseCSV splits rows and fields", () => {
  assert.deepEqual(parseCSV("a,b,c\n1,2,3"), [["a", "b", "c"], ["1", "2", "3"]]);
});

test("parseCSV handles quoted fields with embedded commas and newlines", () => {
  const rows = parseCSV('name,perks\n"Gun A","Outlaw\nKill Clip"\n"B, the Sequel","Rampage"');
  assert.deepEqual(rows[1], ["Gun A", "Outlaw\nKill Clip"]);
  assert.deepEqual(rows[2], ["B, the Sequel", "Rampage"]);
});

test("parseCSV unescapes doubled quotes", () => {
  assert.deepEqual(parseCSV('a\n"say ""hi"""'), [["a"], ['say "hi"']]);
});

// --- buildFromTab ----------------------------------------------------------

const CSV = [
  "Name,Tier,Rank,Barrel,Mag,Perk 1,Perk 2,Notes",
  'The Martlet,S,1,"Arrowhead Brake\nFluted Barrel","Accurized Rounds","Demolitionist\nRimestealer","Chill Clip",great in PVE',
  "Side Quest,,,,,Attrition Orbs,Kinetic Tremors,untiered but perked", // no tier, has perks → kept
  "Empty Row,,,,,,,nothing here", // no tier, no perks → dropped
  ",,,,,,,blank name", // no name → dropped
].join("\n");

test("buildFromTab maps columns by header, multi-line cells become arrays", () => {
  const out = buildFromTab("Snipers", CSV);
  const m = out.find((e) => e.name === "The Martlet");
  assert.equal(m.tier, "S");
  assert.equal(m.rank, "1");
  assert.equal(m.notes, "great in PVE");
  assert.equal(m.category, "Snipers");
  assert.deepEqual(m.perks.barrel, ["Arrowhead Brake", "Fluted Barrel"]);
  assert.deepEqual(m.perks.perk1, ["Demolitionist", "Rimestealer"]);
  assert.deepEqual(m.perks.perk2, ["Chill Clip"]);
});

test("buildFromTab keeps an untiered weapon that still has recommended perks", () => {
  const out = buildFromTab("Other", CSV);
  const sq = out.find((e) => e.name === "Side Quest");
  assert.ok(sq);
  assert.equal(sq.tier, "");
  assert.deepEqual(sq.perks.perk1, ["Attrition Orbs"]);
});

test("buildFromTab drops rows with no tier and no perks, and rows with no name", () => {
  const names = buildFromTab("Other", CSV).map((e) => e.name);
  assert.ok(!names.includes("Empty Row"));
  assert.equal(names.includes(""), false);
});

test("buildFromTab returns [] when there is no Name column", () => {
  assert.deepEqual(buildFromTab("X", "Foo,Bar\n1,2"), []);
});

// --- buildSetBonusesFromTab ------------------------------------------------

// Real column shape of the Set Bonuses tab (gid=1665223292). Rows are SCATTERED:
// Spire's 2pc and 4pc rows are deliberately split by an unrelated set to prove
// grouping is by `Set` text, not row adjacency.
const SET_CSV = [
  // Col 0 is the sheet's thumbnail column; unparsed, so its exact header is irrelevant.
  "INFO,#,Set,Season,Bonus,Pcs,Tags,Trigger,Effect,ANALYSIS Description,Rank,Tier",
  ",1,TM Custom Spire of the Watcher,S23,Arcbolt,2,pve,on kill,chain lightning,solid 2pc,5,B",
  ",2,Exodus Down Nessus,S24,Kickstart,4,pvp,on reload,reload boost,niche,9,D",
  ",3,TM Custom Spire of the Watcher,S23,Voltshot,4,pve,on hit,big damage,elite 4pc,1,S",
  ",4,Solo Set,S25,Loner,4,pve,always,lone effect,only a 4pc,3,A",
  ",5,,S25,Orphan,2,pve,none,none,no set name,7,C", // no Set → skipped
].join("\n");

test("buildSetBonusesFromTab collapses a set's two rows into one entry", () => {
  const out = buildSetBonusesFromTab(SET_CSV);
  const spire = out.find((e) => e.name === "TM Custom Spire of the Watcher");
  assert.ok(spire);
  assert.equal(spire.category, "Set Bonus");
  assert.ok(spire.twoPc);
  assert.ok(spire.fourPc);
});

test("buildSetBonusesFromTab lands each grade on the right piece-count", () => {
  const spire = buildSetBonusesFromTab(SET_CSV).find(
    (e) => e.name === "TM Custom Spire of the Watcher",
  );
  assert.equal(spire.twoPc.tier, "B");
  assert.equal(spire.fourPc.tier, "S");
  assert.equal(spire.twoPc.bonus, "Arcbolt");
  assert.equal(spire.fourPc.bonus, "Voltshot");
  assert.equal(spire.twoPc.rank, "5");
  assert.equal(spire.twoPc.trigger, "on kill");
  assert.equal(spire.fourPc.effect, "big damage");
  assert.equal(spire.twoPc.notes, "solid 2pc");
});

test("buildSetBonusesFromTab groups scattered rows of the same set", () => {
  // Spire rows are #1 and #3, split by Exodus Down (#2) — still one entry.
  const out = buildSetBonusesFromTab(SET_CSV);
  const spires = out.filter((e) => e.name === "TM Custom Spire of the Watcher");
  assert.equal(spires.length, 1);
});

test("buildSetBonusesFromTab leaves twoPc null when only a 4pc row exists", () => {
  const solo = buildSetBonusesFromTab(SET_CSV).find((e) => e.name === "Solo Set");
  assert.equal(solo.twoPc, null);
  assert.equal(solo.fourPc.tier, "A");
});

test("buildSetBonusesFromTab skips rows with no Set value", () => {
  const names = buildSetBonusesFromTab(SET_CSV).map((e) => e.name);
  assert.equal(names.includes(""), false);
  assert.equal(names.length, 3); // Spire, Exodus Down, Solo Set
});

test("buildSetBonusesFromTab does not throw on empty or odd Pcs", () => {
  const odd = [
    "Set,Pcs,Bonus,Tier,Rank,Trigger,Effect,ANALYSIS Description",
    "Weird Set,3,Threepiece,S,1,x,y,z", // odd Pcs → row dropped, no entry
    "Blank Pcs Set,,Nothing,,,,,", // empty Pcs → row dropped
  ].join("\n");
  let out;
  assert.doesNotThrow(() => { out = buildSetBonusesFromTab(odd); });
  assert.equal(out.length, 0);
});

test("buildSetBonusesFromTab returns [] when there is no Set column", () => {
  assert.deepEqual(buildSetBonusesFromTab("Foo,Bar\n1,2"), []);
});
