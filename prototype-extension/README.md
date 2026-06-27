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

Click the extension's toolbar icon to open a popup with a checkbox per tier (S–F),
each showing how many of **your owned** weapons fall in it. Tick any combination
(e.g. F + C + B) and:

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
that icon. The glow is applied via a `data-` attribute (not a class) because DIM owns
`className` on those SVGs and rewrites it on every re-render.

## Duplicates — keep vs shard

When you own multiple copies of the same weapon, the extension ranks them against the
**sheet's recommended roll** and picks the single best to keep:

- **Ranking:** recommended Perk 1 + Perk 2 matches dominate, then barrel/mag, then
  masterwork as a tiebreak. The top copy is the **keeper**; the rest are shard candidates.
- **On tiles:** the keeper gets a **green** outline, shard candidates get **red**.
- **In the popup badge:** a green ring (keep) or red ring (shard), with a tooltip reading
  "✓ Keep — best of your copies" / "⚠ Shard — you own a better copy" (the recommended
  perks are shown as glows on the perk circles, not in the tooltip).

Popup controls (independent of the tier checkboxes):

- **Apply to DIM** — filters DIM to weapons that have extra copies; keep/shard outlines
  make the decision obvious in that view.
- **Highlight on tiles** — outlines everywhere, without filtering.
- **Copy** — copies the weapon query.

Locked copies are never flagged for shard, and **Exclude exotics** removes exotics here too. If no copy has any recommended perk, nothing in
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

- The badge identifies the popup's item by the **last clicked `.item` tile** (covers the
  normal flow). Perk highlighting instead keys off the weapon **name in the title**, so it
  also works in the Armory view where there's no clicked instance.
- First load fetches ~21 tabs; afterward it's served from cache.
- Loose matching can in rare cases collide two differently-named weapons.
