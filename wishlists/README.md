# Hosted DIM wishlists

These `.txt` files are **auto-generated** from the [Endgame Analysis tier sheet](https://docs.google.com/spreadsheets/d/1JM-0SlxVDAi-C6rGVlLxa-J1WGewEeL8Qvq4htWZHhY/edit) by the [`Build wishlist`](../.github/workflows/wishlist.yml) GitHub Action (`scripts/build-wishlist.js`). **Do not edit them by hand** — changes are overwritten on the next run.

## Use one in DIM

DIM honors **one** wishlist source at a time, so pick the scope you want and paste its raw URL into **DIM → Settings → Wish Lists**. DIM auto-updates from the URL within ~24h.

| Scope | Raw URL |
| --- | --- |
| All tiers | `https://raw.githubusercontent.com/Reuzehagel/destiny-vault-advisor/main/wishlists/all.txt` |
| S + A (top) | `https://raw.githubusercontent.com/Reuzehagel/destiny-vault-advisor/main/wishlists/top.txt` |
| S only | `https://raw.githubusercontent.com/Reuzehagel/destiny-vault-advisor/main/wishlists/S.txt` |
| A only | `https://raw.githubusercontent.com/Reuzehagel/destiny-vault-advisor/main/wishlists/A.txt` |
| B only | `https://raw.githubusercontent.com/Reuzehagel/destiny-vault-advisor/main/wishlists/B.txt` |

Each lists the **complete recommended roll** (traits + barrel + mag), so DIM flags and highlights full god rolls. Matching rolls show a thumbs-up (`is:wishlist`); the tier rides in the per-weapon `//notes:` so `wishlistnotes:S` works.

To add another scope, add an entry to `SCOPES` in `scripts/build-wishlist.js`.
