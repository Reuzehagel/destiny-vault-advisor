# Keep/shard engine — pure verdict module

Architecture-review Candidate 1. Extract the duplicate keep/shard scoring out of `content.js`'s globals into a pure, testable module `keepshard.js`.

## Why

The richest domain logic (god-roll keep/shard scoring) currently reads the `vault`/`tierMap` globals and writes its verdict into `redundant`/`keepers`/`keeperInfo`/`keeperUnique` globals as a side effect. Its only test surface is "load a full vault in a live browser." See `CONTEXT.md` for domain vocabulary.

## The module

`globalThis.VaultAdvisor.rankGroup(copies, recommended, { keepCoverage }) → verdict | null`

Loaded as a content script before `content.js` (no bundler); dual CommonJS tail so `node:test` can require it.

- **Input** speaks resolved perk **names** — `copies = [{ id, selectable: string[], masterwork, protected }]`, `recommended = { perk1, perk2, barrel, mag }`. No hashes, no DOM, no IndexedDB.
- **Output** is structured evidence — `{ keepers: [id], total, copies: [{ id, role, hits, matched, depth, godRoll, unique? }] }`. No strings, no colors.
- **One group at a time** — grouping by weapon name stays caller-side.

## Verdict model (three colors, one axis = advice)

- **keeper** (green) — best copy by composite (trait coverage → barrel/mag → depth → masterwork). Exact ties → all tied copies are keepers. A keeper presenting both traits is a **god roll** (`godRoll: true`, caller paints gold).
- **coverage** (yellow) — not a keeper, but brings a recommended **trait** no keeper can present. Only when `keepCoverage` on; greedy-deduped so two copies don't both cover the same trait.
- **shard** (red) — adds no new trait.
- **protected** — user opted out (tags/notes); never shard, excluded from scoring.

Returns `null` (no coloring) for: singletons, groups with no recommended perks, and groups where no copy hits a recommended **trait** (barrel/mag are tiebreak-only, never color a group alone). Advice wins on conflict (a duplicate god roll you should bin is red).

## Out of scope (tracked separately)

The tag/note **skip-list** that computes `protected` — see `issues/02-protected-skiplist.md`. The engine just takes the boolean.
