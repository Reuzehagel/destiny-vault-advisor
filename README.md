# Vault Advisor

A browser extension that adds keep/shard advice and community tier badges inside [DIM](https://app.destinyitemmanager.com).

Click a weapon and you get:

- Its community tier (S–F) on the item popup.
- The recommended god-roll perks glowing on DIM's own perk circles.
- When you own duplicates, the best copy outlined green (keep), the rest red (shard).

No OAuth, no Bungie API key, no CSV import/export. It reads DIM's own cached inventory and manifest straight from the browser.

## Install

See [INSTALL.md](INSTALL.md).

## Where tiers come from

The community compendium ([theaegisrelic's sheet](https://docs.google.com/spreadsheets/d/1JM-0SlxVDAi-C6rGVlLxa-J1WGewEeL8Qvq4htWZHhY/edit)), fetched live and cached for 12h. When the sheet updates, badges follow. No code change.

Tier is a property of the weapon, not your roll, and is relative within each weapon category. An S-tier sniper isn't an S-tier glaive.

## Features

Tier badge — click a weapon, its tier shows in the popup top-right, colored by grade. Rank, category, and sheet notes in the tooltip. Weapons not on the sheet show a muted `–`.

Recommended perks — the perks the sheet recommends glow on DIM's perk circles, in the compact list, the socket grid, and the Armory view. Perk 1 / Perk 2 glow bright, barrel / mag softer. Unrolled perks light up too, so you can see what's worth chasing.

Keep vs shard — when you own multiple copies, it ranks them against the recommended roll and picks the single best to keep. Ranking goes Perk 1 + Perk 2 first, then barrel/mag, then depth (how many recommended perks the copy can toggle between), then masterwork. Keeper gets a green outline, shard candidates red. It scores selectable perks, not just the socketed one, so a craftable or multi-perk drop that can toggle to a recommended perk gets credit.

Toolbar popup — two tabs. Advisor builds one combined tiers + dupes filter and drops it into DIM's search (or copies it). Wishlist turns the whole sheet into a DIM wishlist file.

## How it works

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest. Loads in Firefox and Chromium. |
| `background.js` | Service worker. Fetches the tier sheet, parses it (`sheet.js`), caches it in `chrome.storage` (12h TTL). |
| `sheet.js` | CSV → entries parser for the sheet. Shared by the worker and the Node wishlist builder. |
| `content.js` | Runs on the DIM page. Reads the vault from IndexedDB, injects badges, glows perks, ranks duplicates. |
| `popup.html` / `popup.js` | Toolbar popup. Holds no data, asks `content.js`. |
| `wishlist.js` | Sheet → DIM-wishlist generator. Used by the in-extension export and the hosted build. |
| `scripts/build-wishlist.js` + `.github/workflows/wishlist.yml` | CI that regenerates the hosted wishlist files. See [`wishlists/README.md`](wishlists/README.md). |

A content script injected into `app.destinyitemmanager.com` runs against the page's origin, so it can read DIM's own `keyval-store` IndexedDB — accounts, the raw profile, and the manifest tables. No API needed.

## Known limitations

- The badge identifies the popup's item by the last clicked tile. Perk highlighting keys off the weapon name in the title, so it also works in the Armory view.
- First load fetches ~21 sheet tabs, then it's served from cache.
- Loose name matching can rarely collide two differently-named weapons.
