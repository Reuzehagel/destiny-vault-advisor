# Vault Advisor

A local Destiny 2 vault **advisor** — not a mover. DIM helps you shuffle gear; this tells
you *what's worth keeping*. Drop in your DIM CSV export and it flags armor you can safely
shard, duplicate exotics, and your best rolls.

Everything runs in your browser. No Bungie API key, no OAuth, no data leaves your machine.

## Stack

- **Vite + React + TypeScript** — local web app
- **Effect** — typed-error parse pipeline (`src/parse/dimArmor.ts`) + analysis
- **papaparse** — CSV tokenizing

## Run

```bash
pnpm install
pnpm dev      # open http://localhost:5173
```

Click **"or try sample data"** to see it work without exporting anything.

## How to get your data

DIM → Settings → scroll to **"Export to CSV"** → **Armor** (and **Weapons** later).
Drag the file onto the dropzone.

## What it does (armor, phase 1)

- **Shard** — a piece beaten on *every* stat by another of the same class/slot/rarity, with a
  lower total. Safe to dismantle. Locked or keep/favorite-tagged pieces are never flagged.
- **Dupe** — duplicate exotic; you own a higher-total copy.
- **Top roll** — total in the top ~15% of that slot.

Stat columns are **detected from the CSV header** (`src/domain/model.ts`), so both the legacy
six-stat layout and the post-2025 Armor 3.0 names work without code changes.

## Architecture notes

- `src/domain/model.ts` — normalized `ArmorPiece` model + stat-name candidates
- `src/parse/dimArmor.ts` — CSV → typed model, with tagged errors (`CsvParseError`,
  `NoStatColumnsError`, `NoArmorRowsError`)
- `src/domain/analysis.ts` — pure analysis functions (dominance, dupes, top rolls)
- `src/App.tsx` — UI; runs the Effect pipeline via `Effect.runPromiseExit`

## Roadmap

- [ ] **Phase 2 — Weapons.** Ingest the community god-roll spreadsheet, parse `weapons.csv`,
      tag rolls as keep / good-enough / trash by matching perks.
- [ ] Fairer dominance (compare base stats, accounting for masterwork +2).
- [ ] Stat-focus grouping (e.g. "good Resilience/Recovery pieces").
- [ ] Optional: deploy a Cloudflare Worker via Alchemy for phone access + manifest cache.
