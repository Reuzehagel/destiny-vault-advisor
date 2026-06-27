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
The badge tooltip names the category so that's clear. Your actual roll's perks are
shown too, as context for a future "is this a god roll?" check.

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

Click the extension's toolbar icon to open a popup with a checkbox per tier (S–F),
each showing how many of **your owned** weapons fall in it. Tick any combination
(e.g. F + C + B) and:

- **Apply to DIM** — drops a `(name:"…" or name:"…")` query into DIM's search box, so
  the matching weapons are filtered live.
- **Copy** — copies the query to your clipboard instead.

Because it's built from weapons you actually own, the query stays short. DIM has no
native "tier" concept, so matching is by weapon name. **Exclude exotics** (top of the
popup) drops exotics from the counts, tier search, and redundancy.

## Redundant rolls (shard helper)

When you own multiple copies of the same weapon, the extension scores each copy by
how many of the **sheet's recommended perks** it has. Copies worse than your best
copy are flagged as shard candidates:

It's its own section in the popup (independent of the tier checkboxes):

- **Apply to DIM** — filters DIM to the weapons that have a shardable copy and turns on
  the outline, so the worse copies are the red-outlined tiles in that view.
- **Highlight on tiles** — outlines shard candidates everywhere, without filtering.
- **Copy** — copies the weapon query.
- The popup badge gains a red ring, and its tooltip shows the recommended perks
  ("Want: …"), your roll, and "⚠ Redundant — you own a better-rolled copy."

Locked copies are never flagged, and **Exclude exotics** removes exotics here too. If no copy has any recommended perk, nothing in
that group is flagged (there's no clear "better" copy to keep).

## Name matching & coverage

Sheet names and in-game names are matched after **normalization** (accent strip,
curly→straight apostrophes, lowercase, collapsed whitespace), with an
alphanumeric-only **loose fallback** when the exact key misses. The same
`normalizeName()` lives in both `background.js` and `content.js` and must stay in sync.

The popup shows a coverage line — `On tier list: 142/150 owned weapons` — and clicking
it copies the **unmatched** names so real mismatches (vs. weapons genuinely absent from
the sheet) can be spotted and fixed.

## Known prototype limitations

- Identifies the popup's item by the **last clicked `.item` tile** (covers the normal flow).
- The `Other` tab parses to 0 rows (different layout) — not yet handled.
- First load fetches ~21 tabs; afterward it's served from cache.
- Loose matching can in rare cases collide two differently-named weapons.
