"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeName, looseName, perkKey, iconBase } = require("./naming.js");

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
