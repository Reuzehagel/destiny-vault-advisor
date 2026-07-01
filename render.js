/**
 * render.js — the pure render DECISIONS.
 *
 * "Given a verdict, what should the badge say / what colour is the tile / which
 * perk circles glow?" — the questions, separated from the DOM poking that answers
 * them. content.js keeps the imperative half (createElement, setAttribute, style),
 * but every CHOICE it makes lives here as a pure function, so the rendering rules
 * are unit-testable without a browser or a fake DOM.
 *
 * This is deliberately NOT a DOM abstraction: there's only one renderer (DIM's live
 * page), so wrapping document behind an interface would be indirection without a
 * second implementation. The leverage is a test surface for the decisions, nothing
 * more. See CONTEXT.md for the verdict vocabulary.
 *
 * Loaded as a content script after naming.js; CommonJS tail for node:test.
 */
(function (root) {
  "use strict";

  const naming = (typeof require === "function" ? require("./naming.js") : root.VaultAdvisor) || {};
  const { perkKey } = naming;

  // Tile outline colour per render kind. keeper splits into a plain green keeper and a
  // purple god roll; coverage is yellow (your call); shard is red. protected → no tile.
  const TILE_COLOR = { keep: "#3fb950", godroll: "#c264fe", coverage: "#f5d442", shard: "#f85149" };

  // Tier-letter grade palette (S→F), the badge FILL colour — shared by the weapon pill
  // and the armor split pill so neither invents its own colours. UNKNOWN_COLOR is the
  // muted grey for a grade that isn't on the sheet (the "–" pill). content.js imports
  // both rather than keeping a second copy.
  const TIER_COLOR = {
    S: "#f5b942", A: "#3fb950", B: "#58a6ff", C: "#d2a8ff",
    D: "#d29922", E: "#db6d28", F: "#f85149",
  };
  const UNKNOWN_COLOR = "#6e7681";

  // Verdict role → the kind of tile outline to draw, or null for "leave it alone"
  // (protected copies, and anything with no actionable verdict).
  const tileKind = (vd) =>
    !vd ? null
      : vd.role === "keeper" ? (vd.godRoll ? "godroll" : "keep")
        : vd.role === "coverage" ? "coverage"
          : vd.role === "shard" ? "shard"
            : null;

  // Badge ring class for a tier descriptor ({ role, godRoll }). "" = no role ring
  // (e.g. a tiered weapon you own only one of). godRoll wins over a plain keeper.
  const badgeClass = (tier) =>
    !tier ? ""
      : tier.godRoll ? "va-godroll"
        : tier.role === "keeper" ? "va-keep"
          : tier.role === "coverage" ? "va-coverage"
            : tier.role === "shard" ? "va-redundant"
              : tier.role === "protected" ? "va-protected"
                : "";

  // The verdict sentence(s) for the tooltip: a primary { verdict } line and an optional
  // { why } detail. Pure over the per-copy verdict entry — same fields content.js stores
  // in verdictById. Returns empty strings when there's nothing to say.
  function verdictLines(vd) {
    if (!vd) return { verdict: "", why: "" };
    const role = vd.role;
    let verdict = "";
    let why = "";
    if (role === "keeper") {
      verdict = vd.godRoll
        ? "★ Keep — god roll (every recommended perk)"
        : (vd.hits && vd.hits.length)
          ? `✓ Keep — best roll: ${vd.hits.join(" + ")}`
          : "✓ Keep — best of your copies";
    } else if (role === "coverage") {
      const unique = vd.unique || [];
      verdict = `◆ Your call — only copy that can roll ${unique.join(" + ")}`;
    } else if (role === "protected") {
      verdict = `🔒 Protected — ${vd.protectedReason || "excluded from keep/shard"}`;
    } else if (role === "shard") {
      verdict = `⚠ Shard — you own a better copy (${vd.total} total)`;
      const mine = vd.hits || [];
      const keeperHits = vd.keeperHits || [];
      const sameHits =
        mine.length && keeperHits.length &&
        mine.slice().sort().join("|") === keeperHits.slice().sort().join("|");
      if (sameHits) {
        // Same recommended traits as the keeper. If the keeper switches between more
        // recommended perks, say so (verifiable from depth); otherwise it edged ahead on a
        // recommended barrel/mag or on masterwork — we don't carry which, so don't claim one.
        why = vd.keeperDepth > vd.depth
          ? `· keeper has more recommended perks to switch between (${vd.keeperDepth} vs ${vd.depth})`
          : "· keeper edges it on barrel/mag or masterwork";
      } else if (keeperHits.length) {
        why = `· keeper rolls ${keeperHits.join(" + ")}; this ${mine.length ? `rolls ${mine.join(" + ")}` : "has none of the recommended perks"}`;
      }
    }
    return { verdict, why };
  }

  // Recommended perk names → Map<perkKey, "primary"|"secondary">. perk1/perk2 are the
  // god-roll traits (primary, strong glow); barrel/mag are secondary (subtler). First
  // assignment wins, so a trait that's also listed as secondary stays primary.
  function recommendedTiers(perks) {
    const m = new Map();
    if (!perks) return m;
    const add = (col, kind) => {
      for (const n of col || []) {
        const k = perkKey(n);
        if (k && !m.has(k)) m.set(k, kind);
      }
    };
    add(perks.perk1, "primary");
    add(perks.perk2, "primary");
    add(perks.barrel, "secondary");
    add(perks.mag, "secondary");
    return m;
  }

  // One on-screen perk circle maps (by icon) to a SET of plug names; decide its glow.
  // Glow if ANY name is recommended, and let a primary (god-roll) match beat a secondary
  // (barrel/mag) one. Returns "primary" | "secondary" | null.
  function glowTier(names, tiers) {
    if (!names) return null;
    let kind = null;
    for (const n of names) {
      const k = tiers.get(n);
      if (k === "primary") return "primary";
      if (k) kind = k;
    }
    return kind;
  }

  // --- Armor set-bonus split badge ------------------------------------------
  // Armor grades are SET-bound: a set carries two independent bonuses (a 2-piece and a
  // 4-piece), each with its own tier letter. The badge is one pill with two solid halves
  // — 2pc left, 4pc right — reusing the weapon pill's TIER_COLOR palette and footprint.
  // No keep/shard role ring: that's weapon-only (see badgeClass).

  // One tooltip line for a set bonus: "2pc · <bonus> (<grade>) — <trigger/effect>".
  // Trigger/effect/notes come from the sheet (issue 05's lookup); degrade when blank.
  const bonusLine = (h) =>
    `${h.pcs}pc · ${h.bonus || "Set bonus"} (${h.grade})${h.detail ? ` — ${h.detail}` : ""}`;

  // A set's two bonus grades → the split-pill render decision. `set` is the looked-up
  // Set Bonuses entry (issue 05): { twoPc, fourPc }, each { tier, bonus, trigger, effect,
  // notes } or null. A slot is "graded" only when its tier is a real letter in TIER_COLOR;
  // a present-but-untiered slot counts as absent. Three shapes, mirroring the weapon pill:
  //   both graded -> { kind: "split",  halves: [2pc, 4pc] } — two solid halves
  //   one graded  -> { kind: "single", grade, color }       — the existing single pill
  //   neither     -> { kind: "muted",  grade: "–", color }  — same as an untiered weapon
  function armorBadge(set) {
    const half = (raw, pcs) => {
      const color = raw && TIER_COLOR[raw.tier];
      if (!color) return null;
      return { pcs, grade: raw.tier, color, bonus: raw.bonus || "", detail: raw.effect || raw.trigger || raw.notes || "" };
    };
    const two = half(set && set.twoPc, 2);
    const four = half(set && set.fourPc, 4);
    const reasons = [two, four].filter(Boolean).map(bonusLine);

    if (two && four) return { kind: "split", halves: [two, four], reasons };
    const only = two || four;
    if (only) return { kind: "single", grade: only.grade, color: only.color, reasons };
    return { kind: "muted", grade: "–", color: UNKNOWN_COLOR, reasons: ["Set not on the tier sheet."] };
  }

  // The DIM search OR-ing weapon names together, for "filter to weapons with a shardable
  // copy". Pure over the name list; the caller collects which names from verdictById.
  const redundantQuery = (names) =>
    names && names.length ? "(" + names.map((n) => `name:"${n.replace(/"/g, "")}"`).join(" or ") + ")" : "";

  const api = { TILE_COLOR, TIER_COLOR, UNKNOWN_COLOR, tileKind, badgeClass, verdictLines, recommendedTiers, glowTier, redundantQuery, armorBadge };
  root.VaultAdvisor = Object.assign(root.VaultAdvisor || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
