# Vault Advisor — DIM Tier Badge

A browser extension that adds **live keep/shard advice inside DIM** ([Destiny Item
Manager](https://app.destinyitemmanager.com)). Click a weapon and its community tier
(S–F) appears on the item popup; the god-roll perks glow gold right on DIM's own perk
circles; and when you own duplicates, the best copy is outlined green (keep) and the
rest red (shard).

No OAuth, no Bungie API key, no CSV export/import. The extension reads DIM's own cached
inventory and manifest straight out of the browser, so the advice follows whatever's
already loaded in your DIM tab.

## How it works

| Piece | Role |
| --- | --- |
| `manifest.json` | MV3 manifest. Loads in both Firefox and Chromium. |
| `background.js` | Service worker. Fetches the community tier sheet (CORS-free via host permission), parses 870+ weapons into a name → tier + recommended-perks map, caches it in `chrome.storage` (12h TTL). |
| `content.js` | Runs on the DIM page. Reads your vault from IndexedDB, injects the tier badge, glows recommended perks on the perk circles, and ranks duplicate copies (keep vs shard). |
| `popup.html` / `popup.js` | Toolbar popup: one composable filter (tiers ∩ dupes) with a live summary and a single "Apply to DIM" / "Copy query". Holds no data — it asks `content.js`, which has the vault + tier map in memory. |

### Why a content script can read DIM's data

A content script injected into `app.destinyitemmanager.com` runs against the **host
page's origin**, so it can open DIM's own `keyval-store` IndexedDB — exactly what DIM
caches, no API needed:

| Key | What's in it |
| --- | --- |
| `accounts` | Your Bungie accounts (gives `membershipId`) |
| `profile-{membershipId}` | The full raw Bungie `DestinyProfileResponse` — every item, stat, socket |
| `d2-manifest-InventoryItem` (+ other tables) | Definitions: hash → name, type, tier, perks |

(This was first proven by a throwaway read-only spike; the spike has since been removed,
but the finding is the whole foundation of the extension.)

### Where the tiers come from

The community compendium
([theaegisrelic's sheet](https://docs.google.com/spreadsheets/d/1JM-0SlxVDAi-C6rGVlLxa-J1WGewEeL8Qvq4htWZHhY/edit)),
fetched live and cached. When the sheet updates, badges follow — no code change.

**Tier is weapon-bound** (a property of the weapon, not your roll) and **relative within
each weapon category** — an S-tier sniper isn't an S-tier glaive.

## Load it

First, **open DIM, sign in, and let your inventory finish loading** at least once so the
cache exists. Then side-load the unpacked extension from this repo's root:

- **Firefox:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* → pick
  `manifest.json`. Reload DIM. (Temporary add-ons are removed on restart.)
- **Chromium (Chrome / Edge / Brave / Arc):** `chrome://extensions` → enable *Developer
  mode* → *Load unpacked* → select this repo's folder. Reload DIM.

Click any weapon. Content-script logs are under `[VA-BADGE]`; the worker's logs are on its
*Inspect* page (`about:debugging` / `chrome://extensions`). Weapons not on the sheet show
a muted `–`.

## Features

### Tier badge

Click a weapon → its tier (S–F) appears in the popup's top-right, colored by grade, with
rank, category, and the sheet's notes in the tooltip.

### Recommended perks — the ideal roll, in place

The perks the sheet recommends **glow gold on DIM's own perk circles** — in the compact
list, the expanded socket grid, and the full Armory view. Perk 1 / Perk 2 (god-roll
perks) glow bright; barrel / mag glow softer. It highlights **every** recommended option,
including ones you haven't rolled, so an unrolled god-roll perk still lights up as "worth
chasing".

DIM's perk circles carry only an icon in the DOM (the name is hover-only), so the
extension indexes every plug in the manifest by `icon → name` and matches the sheet's
recommended names to on-screen circles via that icon. Because different plugs can share
one icon, each icon maps to a *set* of names. The glow is applied via a `data-` attribute
(not a class) because DIM owns `className` on those SVGs and rewrites it on every
re-render.

### Duplicates — keep vs shard

When you own multiple copies of a weapon, the extension ranks them against the sheet's
recommended roll and picks the single best to keep:

- **Ranking:** recommended Perk 1 + Perk 2 matches dominate, then barrel/mag, then *depth*
  (how many recommended perks the copy can toggle between), then masterwork.
- **On tiles:** keeper = green outline, shard candidates = red.
- **In the popup badge:** a green ring (keep) or red ring (shard), with a tooltip that
  names the recommended perks involved — e.g. "✓ Keep — best roll: Reconstruction + Chill
  Clip".

Scoring counts **selectable** perks, not just the socketed one: a multi-perk drop or
crafted weapon that can *toggle* to a recommended perk is credited with it. Keep/shard
ranks by **roll**, not power — a low-power copy with the better perks is still the keeper.

Popup controls:

- **Keep complementary rolls** (default on) — also keep an extra copy when it's your only
  source of a recommended trait perk, instead of sharding it. Turn off for an aggressive
  single-keeper purge.
- **Highlight on tiles** — outlines everywhere, without filtering.
- **Apply to DIM** / **Copy** — drop a `(name:"…" or …)` query into DIM's search box, or
  copy it.

Locked copies are still flagged (the badge appends *· unlock first*) rather than hidden.
**Exclude exotics** drops exotics from the counts, tier search, and duplicate ranking.

### One filter, one action (toolbar popup)

Tiers and duplicates are a single composable filter, not two separate searches:

- **Tiers** — tick any combination (none = no tier constraint). 
- **Only weapons with dupes** — a toggle that intersects the tier filter with "has a
  shardable copy". Empty tiers + dupes-on = all your shardable dupes; A/S + dupes-on = just
  your A/S weapons that have dupes; F + dupes-off = all your F-tier junk.
- **Highlight shard picks on tiles** — a live overlay (outlines copies as you toggle); not
  part of the query.
- **Shard rules** — *keep complementary rolls* and the *never-shard-if-tagged* tags/note
  define what counts as shardable; they feed both the filter and the highlight.
- **Apply to DIM** / **Copy query** — drop the combined `(name:"…" or …)` search into DIM,
  or copy it. The summary band shows `N weapons match · M shardable` live.

## Name matching & coverage

Sheet names and in-game names are matched after **normalization** (accent strip,
curly→straight apostrophes, lowercase, collapsed whitespace), with an alphanumeric-only
**loose fallback** when the exact key misses. The same `normalizeName()` lives in both
`background.js` and `content.js` and must stay in sync.

## Known limitations

- The badge identifies the popup's item by the **last clicked `.item` tile** (covers the
  normal flow). Perk highlighting instead keys off the weapon **name in the title**, so it
  also works in the Armory view where there's no clicked instance.
- First load fetches ~21 sheet tabs; afterward it's served from cache.
- Loose name matching can in rare cases collide two differently-named weapons.

## Roadmap ideas

- A native build/lint setup (the code is hand-written vanilla JS today).
- Guard the duplicated `normalizeName()` with a shared module or a test.
- See `dim-issue-draft.md` for a stat-target armor-planner feature pitched upstream to DIM.
