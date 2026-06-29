# 2. Sheet → DIM wishlist: generate, don't re-highlight

Status: Accepted — 2026-06-29 (both delivery paths chosen; extension export ships first)

## Context

The extension highlights recommended perks in-page by injecting outlines into DIM's `.item-popup` / `.armory` DOM. DIM already has a first-class mechanism for "which rolls/perks are good": **wishlists**. A wishlist marks matching rolls (thumbs-up), is searchable (`is:wishlist`, `wishlistnotes:`), shows the curator's picked perks, and works in every DIM view — without our fragile DOM injection, and persistently even when the extension isn't running. The sheet's author had already hand-made one (since paused), distributed via Discord pins.

But a wishlist judges a roll **in isolation**. It has no idea how many copies you own, so it cannot express the extension's core value: *given your copies, keep the best, shard the rest, but spare the one that's your only source of a recommended perk, and never shard a tagged keep.* That cross-copy keep/shard/coverage reasoning needs live inventory; nothing in the wishlist format can say it.

## Decision

Generate a DIM wishlist from the sheet, and split responsibilities cleanly:

- **Wishlist = the static "which rolls are good" layer** → delegate to DIM (highlighting, search, persistence). This lets the in-page perk-glow injection eventually be **retired** — the same "delegate to DIM's own mechanism" call that removed the armor-cleanup presets.
- **The engine = the dynamic "given MY copies, what do I do" layer** (`keepshard.js`) → the part only the extension can do. Kept.

Generation is a **pure module** (`wishlist.js`), paired 1:1 with a test, matching the seams in [ADR-0001](0001-pure-module-seams.md): sheet entries + two injected lookups (`weaponHashes(normName)`, `weaponPlugs(weaponHash)`) → wishlist text + coverage stats. `buildLookups(itemTable, plugSetTable)` derives the lookups from DIM's manifest; it never fetches or touches the DOM, so the same generator serves any delivery path.

Matching rules:

- **Trait cartesian, with a barrel/mag mode.** DIM's `perks=` is an AND, so "perk1 ∈ {A,B} and perk2 ∈ {C,D}" expands to the cartesian product of the two trait columns. A `mode` (set on the Wishlist tab) decides how barrel/mag factor in: `traits` (traits only — broadest, but DIM won't highlight a barrel/mag), or `full` (default — trait × trait × barrel × mag, so the matched roll carries the barrel/mag and DIM highlights all four; only complete rolls match). Barrel/mag resolve per-weapon like traits.

  A third `secondary` mode was tried and **dropped**: it emitted a traits-only line (to flag broadly) plus separate `traits+barrel` / `traits+mag` lines (to highlight each when present). It doesn't work — **DIM highlights only the simplest matching roll, not the union of all matching lines**, so the barrel/mag lines never lit up (confirmed live: full roll highlights barrels, secondary did not). The broad-flag-*and*-highlight-secondaries goal is simply not expressible in the wishlist format.
- **Resolve perks PER WEAPON, non-enhanced.** Each cited hash is taken from that specific weapon's own plug sets (`socketEntries[].randomizedPlugSetHash` / `reusablePlugSetHash` → `PlugSet.reusablePlugItems[].plugItemHash`, `currentlyCanRoll`), so it's guaranteed valid on the item. We keep the **non-enhanced** variant — DIM normalizes enhanced itself and rejects enhanced hashes. Base and enhanced share the same display NAME, so enhanced is detected by `itemTypeDisplayName` (`"Enhanced Trait"` vs `"Trait"`), never the name.
- **Tier rides in `//notes:`** (`//notes:Tier S. …`), so `wishlistnotes:S` works in DIM. The block format mirrors the author's hand-made list (`// name`, `//notes:`, then `dimwishlist:` lines).
- **Coverage stats** report perk names that resolve on **no** weapon (sheet ↔ manifest name drift) and weapons with no rollable recommended combo — these must be visible, never silent.

### Correction (why per-weapon)

An earlier version of this ADR claimed a global name→hash map was safe because "a line citing a hash a weapon can't roll simply never matches (a dead line)." **That was wrong.** DIM *validates* every cited hash against the item and flags the invalid ones loudly (a wall of red ⚠). A perk *name* is also ambiguous in the manifest — "Demolitionist" is a weapon trait **and** its enhanced twin **and** a ghost mod **and** an armor archetype, each a different hash. Citing all of them produced mostly-invalid rolls. The per-weapon resolution above is the fix: only hashes a weapon genuinely rolls are cited, so over-inclusion is self-correcting (no plug set → no line) instead of invalid.

### Delivery

**Constraint:** DIM honors only **one** wishlist source at a time (external URL *or* a file list, not both; multiple URLs aren't stacked — the community consolidates into a single "voltron" file). So tier choice comes from **which file**, never from subscribing to several. The generator is otherwise delivery-agnostic; only the **manifest source** and the **sink** differ, and **tier-scoping is just an input filter** (`entries.filter(e => tiers.has(e.tier))` before `buildWishlist`) — the module is unchanged.

Both halves ship:

- **Hosted on GitHub (CI auto-updated).** A scheduled Action fetches the sheet + the Bungie manifest (API key as a repo secret), runs `wishlist.js` in Node, and commits:
  - `all.txt` — every tier. The canonical subscribe-once URL: whole community list, auto-updating, usable **without** the extension, shareable in the sheet's Discord.
  - a few **curated scope files** (e.g. `S.txt`, `top.txt` = S+A) for the common "best only" asks — not all 2⁷ combos, since DIM takes one source.
  No server; the "backend" is CI + a committed `.txt` + a Bungie API key.
- **In-extension export (custom front door).** The popup's existing tier checkboxes drive a "Get wishlist" action that either **copies the raw GitHub URL** when the selected scope matches a published file (auto-updating), or **downloads a client-side `.txt`** generated from DIM's cached manifest for any arbitrary tier combo (static, but exactly your scope). No new permissions.

**Build order: extension export first** — it delivers the custom-scope feature, proves name→hash resolution end-to-end, and de-risks the hosted side (which then only swaps the IndexedDB manifest for a Bungie-API fetch in CI). The hosted `all.txt` + scopes follow once coverage looks clean and the sheet's author is on board.

## Consequences

- **+** The "good roll" layer becomes native DIM (every view, searchable, persistent); the fragile in-page perk highlighting can be retired.
- **+** Sharpens the product's identity: the extension is *the advisor a wishlist can't be*; the wishlist is the shareable artifact.
- **+** `wishlist.js` is pure and tested like the other seams; one generator serves both delivery paths.
- **−** Resolution leans on the `PlugSet` manifest table (DIM caches it) plus each weapon's socket plug sets; a perk the manifest names differently than the sheet won't match. Surfaced by coverage stats (unmatched perks/weapons), not eliminated.
- **−** Output is still large (per weapon: reissues × |perk1| × |perk2|), but far smaller than a name-based expansion — each perk resolves to a single non-enhanced hash, not base × enhanced × every same-named plug.
- **−** Path B, if taken, adds a Bungie API key + CI + hosting.
