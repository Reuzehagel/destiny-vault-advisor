# Context — Vault Advisor domain language

The ubiquitous language for this project. Use these terms exactly in code, comments, issues, and tests. When a concept here has a precise meaning, don't drift to a synonym.

## Perks on a copy

A weapon **copy** is one owned instance (`itemInstanceId`). Three distinct perk concepts — keep them separate:

- **Socketed** — the perks currently *selected* on the copy, one per column (DIM's highlighted top row). Transient display state. **Not a scoring input**: switching is free, so what's socketed right now can't make a copy better or worse.
- **Selectable** — every perk *this specific copy* can freely switch between (DIM's full perk grid for the instance). **This is the unit of judgment** for keep/shard — a copy is scored by everything it *can present*, never by what happens to be socketed.
- **Perk pool / can-roll** — every perk the weapon's archetype *could* theoretically roll. Broader than any one copy's selectable set. **Out of scope** for keep/shard (it's about chasing a better drop, not choosing between copies you own).

### Gear tiers (why selectable matters)

Modern weapons carry **multiple selectable perks per column**, all free to switch:

- **T3–T5** drops have several options per column. A **T5** weapon has **2 barrel · 2 mag · 3 perk1 · 3 perk2**.
- Older random rolls / lower tiers may have a single fixed perk per column — there, selectable is just size-1 per column. The engine treats every copy uniformly through its **selectable** set.

## Tier (the badge grade)

- **Tier** is **weapon-bound** — a property of the weapon, keyed by name — and **relative within each weapon category** (an S-tier sniper ≠ an S-tier glaive). Sourced from the community compendium sheet (see README).
- Distinct from **gear tier (T1–T5)** above, which is a per-copy drop-quality concept. "Tier" alone = the badge grade; say "gear tier" for T1–T5.

## Recommended perks

The sheet recommends perks by column: **perk1**, **perk2** (the meaningful **god-roll traits**), plus **barrel** and **mag** (secondary tuning). Each column may list several acceptable options.

## Keep / shard verdict

For a group of duplicate copies of one weapon, each copy gets a **role**, surfaced as a color:

- **Keeper** (green) — the single best copy; the one to keep.
- **God roll** (purple) — a keeper that is the **perfect** copy: it can present **every** recommended option in **both** trait columns (all of perk1 *and* all of perk2), **plus** at least one recommended barrel and one recommended mag. Trait columns need the whole set; barrel/mag need just one. Rare by design — the never-shard gold standard. (Purple, not gold: gold collides with DIM's own perk glow and the gold S-tier badge.)
- **Coverage** (yellow) — not the best copy, but it can present a recommended **trait** the keeper can't. It *fills a gap* — keep-or-shard is the user's call. Only exists when keep-coverage is on.
- **Shard** (red) — adds nothing the keeper doesn't already cover (or has no recommended perks). Safe to dismantle.
- **Protected** (slate, no tile outline) — a copy the user has marked to keep off the decision entirely (see **Protect skip-list** below). It never scores, never becomes the keeper, and is never sharded; it just sits out.

Color encodes **advice** (what to do), on a single axis — when quality and advice conflict (e.g. a duplicate god roll you should dismantle), **advice wins**: the tile is red, and the reason explains why.

## Protect skip-list (the exclude-items feature)

A copy can be **protected** — excluded from keep/shard scoring — so a roll kept for a specific reason (a PvP roll, a build piece) is never advised away. The signal is the user's own **DIM annotations**:

- **Tag** — DIM's per-item tag (`favorite`, `keep`, `archive`, `junk`, `infuse`). The user picks which tags protect; default **none** — protection is opt-in via the popup.
- **Note** — DIM's free-text note. The user supplies keyword(s) in "skip noted items containing"; a copy is protected if its note contains one (case-insensitive substring). Empty = notes ignored. No automatic note parsing — notes go both ways (a real cache had `{tag:"junk", notes:"dismantle"}`), so only the user's explicit keyword counts.

**Sourcing & seam.** Tags/notes are cached locally in DIM's `keyval-store` under the `dim-api-profile` key (`.profiles[<membershipId>-d2].tags[<itemInstanceId>] = { id, tag, notes }`) — the same IndexedDB the vault already reads, no new permissions. The **data** is surfaced by the loader (`dimvault.js` → `vault.annotationByInstance`); the **policy** (which tags/notes count as protected) lives in the caller (`content.js`, next to the scoring call), because it's user configuration, not a property of the data.

- **Depth** — how many distinct recommended options across columns a copy can switch between. More depth = more flexibility; used as a tiebreak below column coverage.
- **god roll** — the perfect copy: every recommended option in both trait columns, plus a recommended barrel and mag.

## Wishlist (the shareable layer)

A **wishlist** is DIM's native list of good rolls: `dimwishlist:item=<weaponHash>&perks=<plugHash>,…` lines that DIM matches (ALL listed perks present) to flag a roll with a thumbs-up, searchable via `is:wishlist` / `wishlistnotes:`. It is the **static** half of the advice — "is this roll good?" — judged per roll, with no knowledge of how many copies you own. The **dynamic** half — keep/shard/coverage across *your* copies — is the engine's, and a wishlist cannot express it. See `docs/adr/0002-sheet-to-dim-wishlist.md`.

- **Generation** is `wishlist.js`: the sheet's recommended perks → wishlist text, pure over two lookups (`weaponHashes`, `weaponPlugs`) that `buildLookups` derives from the InventoryItem + PlugSet manifest tables. Every cited hash is resolved from **that weapon's own plug sets** (guaranteed valid on the item) and kept **non-enhanced** — DIM validates every cited hash and rejects enhanced ones. A **mode** (chosen on the Wishlist tab) sets how barrel/mag factor in: `traits` (perk1 × perk2 only — broad, no barrel/mag highlight) or `full` (default — the complete roll on one line, so DIM highlights barrel/mag too, but only complete rolls match). DIM highlights only the simplest matching roll, not the union of matching lines, so there's no way to flag broadly *and* highlight barrel/mag. Tier rides in `//notes:`.
- **Wishlist coverage** — the generator reports perk names that resolve on no weapon (sheet ↔ manifest name drift) and weapons with no rollable combo, mirroring how tier **coverage** reports owned weapons not on the sheet. Misses are surfaced, never silent.
