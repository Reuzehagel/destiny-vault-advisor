# 1. Pure-module seams: naming, engine, render, vault

Status: Accepted — 2026-06-29

## Context

`content.js` had grown into a single ~1000-line content script that did everything: read DIM's IndexedDB, scored keep/shard, decided badge/tile/glow visuals, normalized names, and poked the DOM. Two costs followed from that:

- **Nothing was testable without a browser.** Every rule — "is this a god roll?", "what does the tooltip say?", "which name matches the sheet?" — only ran inside a live DIM tab against real Bungie data, so it was verified by hand, never in CI.
- **Helpers were copy-pasted.** `perkKey` existed in three files, `normalizeName` in two (with a "MUST stay identical to the other copy" comment — a sync hazard waiting to bite), `iconBase` in two.

## Decision

Split the logic into **pure, Node-`require`-able modules**, each paired 1:1 with a `*.test.js`, and leave `content.js` as a thin shell that does only the things that genuinely need the browser (DOM, IndexedDB, `chrome.runtime` messaging).

| Module | Seam it owns | Speaks |
| --- | --- | --- |
| `naming.js` | name normalization | strings → keys |
| `keepshard.js` | the keep/shard verdict | perk **names** in, structured verdict out |
| `dimvault.js` | IndexedDB → Vault | a `{ allKeys, get }` source in, a Vault value out |
| `render.js` | render **decisions** | verdict in, tooltip text / colour / class out |

The rule: **data and decisions are pure and live in a module; DOM, IDB, and messaging stay in `content.js`.** A module never touches `document`, `indexedDB`, or `chrome`.

Two principles shaped the boundaries:

- **"Two adapters or the seam is hypothetical."** `dimvault.loadVault` takes an injected source: the real one wraps DIM's IndexedDB (`content.js`'s `openKeyvalSource`), the test one wraps a hand-built `Map`. Two real implementations, so the seam earns its keep.
- **We did *not* build a DOM adapter.** There is only one renderer (DIM's live page), so wrapping `document` behind an interface would be a second "adapter" with only one implementation — indirection without leverage. `render.js` extracts the render *decisions* (testable) and leaves the DOM poking in `content.js` (not).

Each module uses an IIFE that attaches to `globalThis.VaultAdvisor` (for the browser) plus a CommonJS export tail (for `node:test`), so one file works as a content script, a service-worker import, and a Node module. `naming.js` is shared with the background service worker via `importScripts` / the Firefox `scripts` array.

## Consequences

- **+** Every rule is unit-tested without a browser (40 tests across four modules); `content.js` shrank by ~40%.
- **+** The duplicated helpers collapse to one definition each; the `normalizeName` sync hazard is structurally gone.
- **−** Five files plus a manifest **load order** (`naming → keepshard → dimvault → render → content`) must stay consistent — a module that reads `globalThis.VaultAdvisor.x` must load after the module that sets it.
- **−** The dual IIFE-plus-CommonJS pattern is boilerplate repeated in each module, the price of running the same file in three contexts (content script, service worker, Node).
- `perkKey` and `iconBase` are no longer re-exported from `keepshard`/`dimvault`; import them from `naming.js`.
