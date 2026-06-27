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
native "tier" concept, so matching is by weapon name.

## Known prototype limitations

- Matches sheet ↔ in-game by **exact (case-insensitive) name**. A few weapons with
  punctuation/reissue differences may miss until name-normalization is added.
- Identifies the item by the **last clicked `.item` tile** (covers the normal flow).
- The `Other` tab parses to 0 rows (different layout) — not yet handled.
- First load fetches ~21 tabs; afterward it's served from cache.
