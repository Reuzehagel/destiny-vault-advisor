"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseCSV, buildFromTab } = require("./sheet.js");

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
