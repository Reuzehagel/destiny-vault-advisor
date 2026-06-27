# Feature idea: a stat-target planner that tells you what armor to chase

## What I'm asking for

A mode in the Loadout Optimizer (or next to it) where I set the stats I want and it tells me the ideal armor *composition* to get there, even if I don't own the pieces yet. So instead of "here's the best set from what you have," it answers "to hit 160 Grenade / 100 Super, you'd want roughly 4x Gunner + 1x Grenadier with these tertiaries, and here's how far your current gear falls short."

Basically a "what should I farm" view rather than a "what can I equip right now" view.

## What already exists (so I'm not asking for a dupe)

I dug through the loadout-builder code before filing this. I know the optimizer already:

- takes stat targets on the 0-200 scale
- models archetypes, tertiary, and tuning
- pulls in vendor armor through `loadout-builder-vendors.ts`, so it already considers gear I could go buy
- shows per-piece stat breakdowns and works out the mod/tuning assignment

That covers a lot. The part I can't find is anything that reasons about *hypothetical* armor. Everything keys off concrete items (owned or currently on sale). If the pieces to hit my target don't exist in my vault and aren't on a vendor this week, the optimizer just can't show me the target, and it can't tell me what kind of drop would close the gap.

## Why I think it's useful

When I'm building toward a stat spread, the question I actually have is "what am I missing and is it even reachable." Right now I answer that by hand: eyeball the archetypes, do the tertiary math, guess. A planner that says "you're one Gunner helmet with a Grenade tertiary away from this" would save the manual work, and it'd tell me when a target is flat-out impossible before I waste a week farming for it.

## Where I think it'd live

I don't think this touches the existing process worker much. The current optimizer searches real items; this would compute over the space of possible archetype + tertiary + tuning combos instead, then diff the ideal against the best set the normal optimizer can build today. The stat-constraint UI and the Armor 3.0 data are already there to reuse.

## What I want to know before writing anything

Mostly whether this fits where you want DIM to go. It leans more theorycraft than inventory management, and I get that DIM isn't D2ArmorPicker. If it's out of scope I'd rather hear that now. If there's interest I'm happy to build it and would want pointers on how you'd want it scoped (separate view vs. a toggle in the optimizer, how aggressive to be about the recommendation, etc.).

I'm comfortable in the codebase and would do the work myself. Just want to check direction first per CONTRIBUTING.
