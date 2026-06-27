# Vault Advisor — Tier Badge (prototype)

Injects a **tier badge** into DIM's item popup. Click a weapon → its tier (S–F)
appears in the popup's top-right, colored by grade, with rank + notes in the tooltip.

The tier comes from the community compendium
([theaegisrelic's sheet](https://docs.google.com/spreadsheets/d/1JM-0SlxVDAi-C6rGVlLxa-J1WGewEeL8Qvq4htWZHhY/edit)),
fetched live and cached. Edit-free: when the sheet updates, badges follow.

## How it works

| Piece | What it does |
| --- | --- |
| `background.js` | Fetches the sheet's weapon tabs (CORS-free via host permission), parses 870+ weapons into a name→tier map, caches it in `chrome.storage` (12h TTL). |
| `content.js` | Reads your vault from DIM's IndexedDB to identify the clicked weapon, asks the worker for the tier map, and injects the badge into `<div class="item-popup">`. |

**Tier is weapon-bound** (it's a property of the weapon, not your roll) and
**relative within each weapon category** — an S-tier sniper isn't an S-tier glaive.
The badge tooltip names the category and shows the sheet's notes plus the keep/shard
verdict. The recommended perks themselves are highlighted directly on DIM's perk
circles (see below), so the tooltip stays about the notes.

## Load it

Open DIM, sign in, let inventory load once. Then:

- **Firefox:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* →
  pick `prototype-extension/manifest.json`. Reload DIM.
- **Chromium:** `chrome://extensions` → enable *Developer mode* → *Load unpacked* →
  select the `prototype-extension/` folder. Reload DIM.

Click any weapon. Logs are under `[VA-BADGE]`. Weapons not on the sheet show a muted
`–`. If the tier list doesn't load, check the service worker's console (on
`about:debugging` / `chrome://extensions`, click the worker's *Inspect*).

## Tier search (toolbar popup)

Click the extension's toolbar icon to open the popup. Each tier (S–F) is a row with
a colored grade chip, a **distribution bar** (how that tier's count compares to your
others, at a glance), and the count of **your owned** weapons in it. The header shows
a coverage stat (`142/150 on tier list`) you can click to copy unmatched names. Tick
any combination of tiers (e.g. F + C + B) and:

- **Apply to DIM** — drops a `(name:"…" or name:"…")` query into DIM's search box, so
  the matching weapons are filtered live.
- **Copy** — copies the query to your clipboard instead.

Because it's built from weapons you actually own, the query stays short. DIM has no
native "tier" concept, so matching is by weapon name. **Exclude exotics** (top of the
popup) drops exotics from the counts, tier search, and redundancy.

## Recommended perks — the ideal roll, in place

When you open a weapon, the perks the sheet recommends **glow gold on DIM's own perk
circles** — in the compact perk list, the expanded socket grid, and the full Armory
view (the screen showing every available perk). This marks the ideal roll right where
you read perks, instead of in a tooltip.

- **Perk 1 / Perk 2** (the god-roll perks) glow **bright**; **barrel / mag** glow a
  touch softer, so the priority is readable at a glance.
- It highlights **every** recommended option, including ones you haven't rolled — so an
  unrolled god-roll perk still lights up as "worth chasing".

How it matches: DIM's perk circles carry only an icon in the DOM (the name is
hover-only), so on load the extension indexes every plug in the manifest by
`icon → name` and matches the sheet's recommended **names** to on-screen circles via
that icon. Because different plugs can **share one icon** (e.g. the perk "One for All"
and the mod "One for All Refit"), each icon maps to a *set* of names and a circle glows
if any of them is recommended — an earlier last-write-wins map silently dropped a perk
whenever a same-art plug with a higher hash existed. The glow is applied via a `data-`
attribute (not a class) because DIM owns `className` on those SVGs and rewrites it on
every re-render.

## Duplicates — keep vs shard

When you own multiple copies of the same weapon, the extension ranks them against the
**sheet's recommended roll** and picks the single best to keep:

- **Ranking:** recommended Perk 1 + Perk 2 matches dominate, then barrel/mag, then
  masterwork as a tiebreak. The top copy is the **keeper**; the rest are shard candidates.
- **On tiles:** the keeper gets a **green** outline, shard candidates get **red**.
- **In the popup badge:** a green ring (keep) or red ring (shard), with a tooltip that
  **explains the verdict** by naming the recommended perks involved — e.g. "✓ Keep — best
  roll: Reconstruction + Chill Clip", or on a shard copy "⚠ Shard — you own a better copy
  (4 total) · keeper has Reconstruction + Chill Clip; this has none of the recommended
  perks". The perks themselves still glow on the perk circles; the tooltip says *why*.

Note: keep/shard ranks by **roll**, not power level — a low-power copy with the better
perks is still the keeper (just infuse it up). It also uses this compendium's recommended
perks, which can differ from DIM's own wishlist (the 👍 markers).

Popup controls (independent of the tier checkboxes):

- **Apply to DIM** — filters DIM to weapons that have extra copies; keep/shard outlines
  make the decision obvious in that view.
- **Highlight on tiles** — outlines everywhere, without filtering.
- **Copy** — copies the weapon query.

Locked copies are never flagged for shard, and **Exclude exotics** removes exotics here too. If no copy has any recommended perk, nothing in
that group is flagged (there's no clear "better" copy to keep).

## Armor cleanup

Armor has no community tier sheet — a piece's worth is computed from its stats for
the build you want (Armor 3.0: stat archetypes, set bonuses, gear tiers T1–T5, the
100-point breakpoint). Rather than reimplement that, the popup's **Armor cleanup**
presets delegate to **DIM's own search filters**, which already encode this logic and
stay current as the sandbox changes. Each preset just drops a query into DIM's search
box (same mechanism as tier search):

| Preset | DIM query | Finds |
| --- | --- | --- |
| **Low / legacy tier** | `is:armor -is:exotic -is:locked tier:<=3` | Gear tier 3 and below. Legacy (pre-Edge-of-Fate) armor reads as tier `0`, so this sweeps obsolete *and* low-tier pieces in one pass. |
| **Worse-stat dupes** | `is:armor -is:exotic -is:locked dupe:setbonus+statlower` | Within each armor set, pieces beaten on every stat by another piece you own — set-aware Pareto dominance, computed by DIM. |

Both exclude exotics and locked pieces. These surface **candidates to review**, not an
auto-shard list — set bonuses and build needs can still make a "worse" piece worth
keeping, so eyeball the filtered results before dismantling.

## Name matching & coverage

Sheet names and in-game names are matched after **normalization** (accent strip,
curly→straight apostrophes, lowercase, collapsed whitespace), with an
alphanumeric-only **loose fallback** when the exact key misses. The same
`normalizeName()` lives in both `background.js` and `content.js` and must stay in sync.

The popup shows a coverage line — `On tier list: 142/150 owned weapons` — and clicking
it copies the **unmatched** names so real mismatches (vs. weapons genuinely absent from
the sheet) can be spotted and fixed.

## Known prototype limitations

- The badge identifies the popup's item by the **last clicked `.item` tile** (covers the
  normal flow). Perk highlighting instead keys off the weapon **name in the title**, so it
  also works in the Armory view where there's no clicked instance.
- First load fetches ~21 tabs; afterward it's served from cache.
- Loose matching can in rare cases collide two differently-named weapons.
