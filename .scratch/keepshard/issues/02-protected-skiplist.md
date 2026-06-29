# Protected copies: user-configurable tag/note skip-list

Status: done (built with Candidate 2, the dimvault adapter)

Let the user mark copies the keep/shard engine should leave alone, by DIM tag or note. The engine already accepts a per-copy `protected` boolean (see `../PRD.md`); this issue is the **policy + data** that computes it.

## Outcome

Shipped. A live cache probe confirmed DIM caches annotations locally under the `dim-api-profile` key (`.profiles[<membershipId>-d2].tags[<id>] = { id, tag, notes }`) — same `keyval-store`, no new permissions.

- **Data:** `dimvault.js` (`loadVault`) surfaces `vault.annotationByInstance: Map<id, {tag, notes}>`.
- **Policy:** `content.js` `protectionFor(id)` maps annotation → `protected` using the popup config, next to the scoring call.
- **Setting:** popup "Never shard if tagged" tag chips (default `favorite` + `keep`) + a "skip noted items containing" keyword box. Carried per-message like the other toggles (in-memory, not `chrome.storage` — matches the existing settings pattern; cross-session persistence can be a later enhancement).
- **Notes decision changed during build:** not "any note present" but a **user-supplied keyword** (substring match). The probe found a `{tag:"junk", notes:"dismantle"}` item — notes are used for shard reasons too, so presence alone would mis-protect. The user picks the keyword instead.
- **Display:** protected copy → slate badge ring + `🔒 Protected — <reason>` tooltip line; no tile outline.

## Scope

1. **Surface tags/notes from IndexedDB.** Confirm DIM's per-item tags (`keep`, `favorite`, `junk`, `infuse`, `archive`) and free-text notes live in the same `keyval-store` the content script already reads, and expose them per `instanceId` from the vault layer. (Rides with Candidate 2, the vault adapter — that's the module that reads IDB.)
2. **Skip-list setting in the popup.** A control where the user picks which tags count as "skip / protected" and whether *any note present* counts. Default on: `keep` + `favorite`. Persist in `chrome.storage`.
3. **Caller maps annotations → `protected`.** For each copy, `protected = true` if its tag is in the skip-set, or (if the note toggle is on) it has a non-empty note. No note-text keyword parsing — presence is the signal.

## Notes

- If tags/notes turn out not to be reachable in IDB, `protected` stays `false` everywhere and nothing breaks — ship the engine without it.
- Display of a protected copy (neutral vs a pin marker) is settled with Candidate 3 (the DOM adapter).
