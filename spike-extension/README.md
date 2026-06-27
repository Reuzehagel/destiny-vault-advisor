# DIM IndexedDB Spike

A throwaway, **read-only** browser extension that answers one architectural question:

> Can an extension content script read DIM's cached inventory + manifest straight
> out of the browser, without OAuth, an API key, or scraping the DOM?

If yes, the Vault Advisor's ranking logic can run live inside DIM and draw a tier
badge on the item popup — no more CSV export/import loop.

## Why this works

Content scripts access the **host page's** origin storage, not the extension's own.
So a script injected into `app.destinyitemmanager.com` can open DIM's IndexedDB
database (`keyval-store`, store `keyval`) and read exactly what DIM caches:

| Key                       | What's in it                                                        |
| ------------------------- | ------------------------------------------------------------------- |
| `accounts`                | Your Bungie accounts (gives `membershipId`)                         |
| `profile-{membershipId}`  | The full raw Bungie `DestinyProfileResponse` — every item, stats, perks |
| `d2-manifest-InventoryItem` (+ other tables) | Definitions: hash → name, type, tier, perks         |

Manifest version is in `localStorage['d2-manifest-version']`.

The spike reads accounts → profile → manifest and resolves **one real weapon
end-to-end** (hash → name, type, tier, perks, stats) to prove the full chain.

## Load it

First, **open DIM, sign in, and let your inventory finish loading** at least once
so the cache exists. Then side-load the unpacked extension:

### Firefox (your primary browser)

1. Go to `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…**
3. Pick `spike-extension/manifest.json`
4. Open/reload `https://app.destinyitemmanager.com/`

Temporary add-ons are removed when Firefox restarts — fine for a spike.

### Chromium (Chrome / Edge / Brave / Arc)

1. Go to `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. **Load unpacked** → select the `spike-extension/` folder
4. Open/reload `https://app.destinyitemmanager.com/`

## Read the result

A panel appears top-left of the DIM page:

- **READ OK** (green) → the content script read DIM's IndexedDB. Architecture confirmed.
- **NO DATA** (red) → see the notes in the panel (usually: sign in / let inventory load / reload).

Full details are logged to the devtools console under `[DIM-SPIKE]`.

Click **Copy report** and paste it back — it's safe to share: counts plus a single
sample item, never your whole vault.

## Firefox vs. Chromium note

This manifest is plain MV3 and loads in both. The one real difference for the
eventual product: Firefox keeps MV2-style blocking/background flexibility and a
`browser_specific_settings.gecko.id`, while Chromium is strict MV3. For a
content-script-only tool like this, both are equivalent — so switching browsers
isn't required, but a Chromium build is trivial from the same source.
