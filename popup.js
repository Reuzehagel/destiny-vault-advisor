/**
 * Toolbar popup — two tabs.
 *
 * Advisor: one composable filter (tiers ∩ "only weapons with dupes") into a single DIM
 * search, plus the live tile highlight and the keep/shard rules. Vault-scoped.
 *
 * Wishlist: the whole tier sheet → a DIM wishlist file (Download / Copy), scoped by tier and
 * by how barrels/mags factor in. Not vault-scoped — it covers every weapon on the sheet.
 *
 * The popup holds no vault data — it asks the content script (which has the vault + tier map +
 * manifest access) to compute summaries, queries, and the wishlist text.
 */
const TIERS = ["S", "A", "B", "C", "D", "E", "F"];
const COLOR = {
  S: "#f5b942", A: "#3fb950", B: "#58a6ff", C: "#d2a8ff",
  D: "#d29922", E: "#db6d28", F: "#f85149",
};

// Hosted wishlists published by scripts/build-wishlist.js (full-roll). Copy a raw URL when the
// selected scope matches one — it auto-updates daily, so the user subscribes once in DIM instead
// of re-importing. Any other scope/mode falls back to the locally-generated Download. Keep the
// tier sets in sync with SCOPES in scripts/build-wishlist.js.
const RAW_BASE = "https://raw.githubusercontent.com/Reuzehagel/destiny-vault-advisor/main/wishlists/";
const HOSTED = [
  { file: "all.txt", tiers: [] },
  { file: "top.txt", tiers: ["S", "A"] },
  { file: "S.txt", tiers: ["S"] },
  { file: "A.txt", tiers: ["A"] },
  { file: "B.txt", tiers: ["B"] },
];
const hostedFile = (tierSet) => {
  const want = [...tierSet].sort().join(",");
  return HOSTED.find((h) => [...h.tiers].sort().join(",") === want)?.file ?? null;
};

const $ = (id) => document.getElementById(id);
const status = (m) => ($("status").textContent = m || "");

const state = {
  // advisor
  exclude: false, dupesOnly: false, highlight: false, keepCoverage: true,
  protectTags: new Set(), protectNote: "",
  // wishlist (independent of the advisor scope)
  wlTiers: new Set(), wlMode: "full",
};

const selectedTiers = () => [...document.querySelectorAll("#tiers input:checked")].map((i) => i.value);

// Advisor recompute settings — carried on every advisor message.
const settings = () => ({
  excludeExotics: state.exclude,
  keepCoverage: state.keepCoverage,
  protectTags: [...state.protectTags],
  protectNote: state.protectNote,
  highlight: state.highlight,
  dupesOnly: state.dupesOnly,
  tiers: selectedTiers(),
});

const getActiveTab = () =>
  new Promise((res) => chrome.tabs.query({ active: true, currentWindow: true }, (t) => res(t[0])));
const sendToTab = (tabId, msg) =>
  new Promise((res) =>
    chrome.tabs.sendMessage(tabId, msg, (r) => res(chrome.runtime.lastError ? null : r)),
  );

let tab = null;

// --- tabs ------------------------------------------------------------------
function setTab(name) {
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.tab === name);
  $("panel-advisor").hidden = name !== "advisor";
  $("panel-wishlist").hidden = name !== "wishlist";
}

// --- advisor ---------------------------------------------------------------
function renderTiers(counts) {
  const keep = new Set(selectedTiers());
  const wrap = $("tiers");
  wrap.innerHTML = "";
  const max = Math.max(1, ...TIERS.map((g) => counts?.[g] || 0));
  for (const g of TIERS) {
    const n = counts?.[g] || 0;
    const pct = Math.round((n / max) * 100);
    const label = document.createElement("label");
    label.className = "row";
    label.title = `${n} ${g}-tier weapon${n === 1 ? "" : "s"}`;
    label.innerHTML = `
      <input type="checkbox" value="${g}" ${n ? "" : "disabled"} ${keep.has(g) && n ? "checked" : ""} />
      <span class="grade" style="background:${COLOR[g]}">${g}</span>
      <span class="bar"><i style="width:${pct}%"></i></span>
      <span class="count">${n}</span>`;
    label.querySelector("input").addEventListener("change", sync);
    wrap.appendChild(label);
  }
}

const setSwitch = (id, on) => $(id).classList.toggle("on", Boolean(on));

function reflectControls() {
  setSwitch("exclude", state.exclude);
  setSwitch("dupes-only", state.dupesOnly);
  setSwitch("highlight", state.highlight);
  setSwitch("keep-coverage", state.keepCoverage);
  for (const b of document.querySelectorAll(".badge")) b.classList.toggle("on", state.protectTags.has(b.dataset.tag));
  $("protect-note").value = state.protectNote;
}

function setSummary(weapons, shardable) {
  $("summary-match").textContent = weapons == null ? "—" : `${weapons} weapon${weapons === 1 ? "" : "s"} match`;
  $("summary-shard").textContent = shardable == null ? "—" : `${shardable} shardable`;
}

async function sync() {
  if (!tab) return;
  const resp = await sendToTab(tab.id, { type: "sync", ...settings() });
  if (!resp) return status("Open DIM to use this.");
  renderTiers(resp.counts || {});
  setSummary(resp.weapons, resp.shardable);
  status(resp.ready ? "" : "Vault still loading in DIM…");
}

async function run(apply) {
  if (!tab) return status("Open DIM in this tab first.");
  const resp = await sendToTab(tab.id, { type: "apply", apply, ...settings() });
  if (!resp) return status("No response — is DIM open and loaded?");
  if (!resp.ok) return status(resp.error || "Vault still loading…");
  if (apply) {
    if (!resp.query) return status("Applied — cleared filter (everything).");
    status(resp.applied ? `Applied — ${resp.weapons} weapons.` : "Couldn't find DIM's search box.");
  } else {
    try {
      await navigator.clipboard.writeText(resp.query);
      status(resp.query ? `Copied query — ${resp.weapons} weapons.` : "Nothing to copy (no filter).");
    } catch {
      status("Clipboard blocked; query in console.");
      console.log(resp.query);
    }
  }
}

function bindSwitch(id, key) {
  $(id).addEventListener("click", () => {
    state[key] = !state[key];
    setSwitch(id, state[key]);
    sync();
  });
}

// --- wishlist --------------------------------------------------------------
let wlBusy = false; // a generate reads the multi-MB manifest; don't stack concurrent runs

async function wishlist(download) {
  const cov = $("wl-cov");
  if (!tab) { cov.textContent = "Open DIM in this tab first."; return; }
  if (wlBusy) return;
  wlBusy = true;
  cov.textContent = "Generating… (reading the manifest)";
  try {
    const resp = await sendToTab(tab.id, { type: "wishlist", tiers: [...state.wlTiers], mode: state.wlMode });
    if (!resp) { cov.textContent = "No response — is DIM open and loaded?"; return; }
    if (!resp.ok) { cov.textContent = resp.error || "Couldn't build the wishlist."; return; }

    const { text, stats } = resp;
    if (download) {
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `vault-advisor-wishlist-${state.wlTiers.size ? [...state.wlTiers].join("").toLowerCase() : "all"}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      try { await navigator.clipboard.writeText(text); } catch { console.log(text); }
    }

    const unmatched = stats.unmatchedWeapons.length + stats.unmatchedPerks.length;
    cov.textContent = `${stats.weapons} weapons · ${stats.lines} rolls${unmatched ? ` · ${unmatched} unmatched` : ""}`;
    if (unmatched) console.log("Wishlist unmatched:", stats.unmatchedWeapons, stats.unmatchedPerks);
  } finally {
    wlBusy = false;
  }
}

// Enable "Copy link" only when the current scope+mode maps to a published full-roll file, and
// nudge toward it (it auto-updates; Download is a static snapshot).
function reflectWishlist() {
  const scopeFile = hostedFile(state.wlTiers); // mode-agnostic
  const file = state.wlMode === "full" ? scopeFile : null;
  const btn = $("wl-link");
  btn.disabled = !file;
  btn.title = file
    ? `Copy the auto-updating raw URL (${file})`
    : "Hosted links cover full-roll scopes only: all, S, A, B, or S+A.";
  $("wl-cov").textContent = file
    ? `Hosted ${file} — Copy link to subscribe once in DIM (auto-updates daily).`
    : scopeFile
      ? `Switch to Full roll to use the hosted ${scopeFile} link.`
      : "";
}

async function copyLink() {
  const file = state.wlMode === "full" ? hostedFile(state.wlTiers) : null;
  if (!file) return; // button is disabled in this state
  const url = RAW_BASE + file;
  try {
    await navigator.clipboard.writeText(url);
    $("wl-cov").textContent = `Copied ${file} link — paste into DIM → Settings → Wish Lists.`;
  } catch {
    $("wl-cov").textContent = url;
    console.log(url);
  }
}

// --- init ------------------------------------------------------------------
async function init() {
  tab = await getActiveTab();
  const resp = tab && (await sendToTab(tab.id, { type: "sync", ...settings() }));
  if (!resp) {
    status("Open DIM to use this.");
    renderTiers({});
    return;
  }
  state.exclude = Boolean(resp.excludeExotics);
  state.keepCoverage = resp.keepCoverage !== false;
  state.highlight = Boolean(resp.highlightOn);
  state.protectTags = new Set(resp.protectTags || []);
  state.protectNote = resp.protectNote || "";
  reflectControls();
  renderTiers(resp.counts || {});
  setSummary(resp.weapons, resp.shardable);
  if (!resp.ready) status("Vault still loading in DIM…");
}

for (const t of document.querySelectorAll(".tab")) t.addEventListener("click", () => setTab(t.dataset.tab));

bindSwitch("exclude", "exclude");
bindSwitch("dupes-only", "dupesOnly");
bindSwitch("highlight", "highlight");
bindSwitch("keep-coverage", "keepCoverage");
for (const b of document.querySelectorAll(".badge")) {
  b.addEventListener("click", () => {
    const tag = b.dataset.tag;
    state.protectTags.has(tag) ? state.protectTags.delete(tag) : state.protectTags.add(tag);
    b.classList.toggle("on", state.protectTags.has(tag));
    sync();
  });
}
// 'change' (blur/enter), not 'input' — avoid recomputing the whole vault on every keystroke.
$("protect-note").addEventListener("change", () => { state.protectNote = $("protect-note").value.trim(); sync(); });
$("apply").addEventListener("click", () => run(true));
$("copy").addEventListener("click", () => run(false));

// wishlist controls — colour the chips from the one COLOR map (no duplicated hexes in HTML)
for (const c of document.querySelectorAll("#wl-tiers .chip")) {
  c.style.background = COLOR[c.dataset.tier];
  c.addEventListener("click", () => {
    const g = c.dataset.tier;
    state.wlTiers.has(g) ? state.wlTiers.delete(g) : state.wlTiers.add(g);
    c.classList.toggle("on", state.wlTiers.has(g));
    reflectWishlist();
  });
}
for (const o of document.querySelectorAll("#wl-mode .opt")) {
  o.addEventListener("click", () => {
    state.wlMode = o.dataset.mode;
    for (const x of document.querySelectorAll("#wl-mode .opt")) x.classList.toggle("sel", x === o);
    reflectWishlist();
  });
}
$("wl-link").addEventListener("click", copyLink);
$("wl-download").addEventListener("click", () => wishlist(true));
$("wl-copy").addEventListener("click", () => wishlist(false));

reflectWishlist();
init();
