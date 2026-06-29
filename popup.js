/**
 * Toolbar popup — one composable filter, one action.
 *
 * Tiers AND an optional "only weapons with dupes" toggle intersect into a single DIM
 * search; "Apply to DIM" commits it, "Copy query" copies it. Highlight is a live tile
 * overlay; keep-coverage + the protect tags are rules that define what counts as shardable.
 *
 * The popup holds no vault data — every control change pings the content script (which has
 * the vault + tier map in memory) for a fresh summary, and the action buttons ask it to
 * build/apply the query.
 */
const TIERS = ["S", "A", "B", "C", "D", "E", "F"];
const COLOR = {
  S: "#f5b942", A: "#3fb950", B: "#58a6ff", C: "#d2a8ff",
  D: "#d29922", E: "#db6d28", F: "#f85149",
};

const $ = (id) => document.getElementById(id);
const status = (m) => ($("status").textContent = m || "");

// Popup-local control state. dupesOnly/highlight start off; the rest are reflected from the
// content script on init (it persists them across popup opens).
const state = {
  exclude: false,
  dupesOnly: false,
  highlight: false,
  keepCoverage: true,
  protectTags: new Set(),
  protectNote: "",
};

const selectedTiers = () => [...document.querySelectorAll("#tiers input:checked")].map((i) => i.value);

// Everything the content script needs to recompute against the current toggles.
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

function renderTiers(counts) {
  const keep = new Set(selectedTiers()); // preserve selection across re-render
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

function setSwitch(id, on) {
  $(id).classList.toggle("on", Boolean(on));
}

// Mirror state into the custom controls (switches, badges, note) — used on init.
function reflectControls() {
  setSwitch("exclude", state.exclude);
  setSwitch("dupes-only", state.dupesOnly);
  setSwitch("highlight", state.highlight);
  setSwitch("keep-coverage", state.keepCoverage);
  for (const b of document.querySelectorAll(".badge")) b.classList.toggle("on", state.protectTags.has(b.dataset.tag));
  $("protect-note").value = state.protectNote;
}

function setSummary(weapons, shardable) {
  $("summary-match").textContent =
    weapons == null ? "—" : `${weapons} weapon${weapons === 1 ? "" : "s"} match`;
  $("summary-shard").textContent = shardable == null ? "—" : `${shardable} shardable`;
}

// Live poll behind every toggle: refresh the tier bars + summary, re-paint tile highlights.
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

// A switch bound to a boolean state key: flip on click, then re-sync.
function bindSwitch(id, key) {
  $(id).addEventListener("click", () => {
    state[key] = !state[key];
    setSwitch(id, state[key]);
    sync();
  });
}

async function init() {
  tab = await getActiveTab();
  const resp = tab && (await sendToTab(tab.id, { type: "sync", ...settings() }));
  if (!resp) {
    status("Open DIM to use this.");
    renderTiers({});
    return;
  }
  // Adopt the content script's persisted flags (dupesOnly is popup-local, stays off).
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

bindSwitch("exclude", "exclude");
bindSwitch("dupes-only", "dupesOnly");
bindSwitch("highlight", "highlight");
bindSwitch("keep-coverage", "keepCoverage");
for (const b of document.querySelectorAll(".badge")) {
  b.addEventListener("click", () => {
    const tag = b.dataset.tag;
    if (state.protectTags.has(tag)) state.protectTags.delete(tag);
    else state.protectTags.add(tag);
    b.classList.toggle("on", state.protectTags.has(tag));
    sync();
  });
}
// 'change' (blur/enter), not 'input' — avoid recomputing the whole vault on every keystroke.
$("protect-note").addEventListener("change", () => {
  state.protectNote = $("protect-note").value.trim();
  sync();
});
$("apply").addEventListener("click", () => run(true));
$("copy").addEventListener("click", () => run(false));
init();
