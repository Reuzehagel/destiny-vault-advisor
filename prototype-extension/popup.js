/**
 * Toolbar popup — pick tiers, build a DIM search of your owned weapons in those
 * tiers, and apply it to (or copy it from) the DIM tab.
 *
 * The popup holds no data; it asks the content script (which has the vault +
 * tier map in memory) to compute counts and the query.
 */
const TIERS = ["S", "A", "B", "C", "D", "E", "F"];
const COLOR = {
  S: "#f5b942", A: "#3fb950", B: "#58a6ff", C: "#d2a8ff",
  D: "#d29922", E: "#db6d28", F: "#f85149",
};

const $ = (id) => document.getElementById(id);
const status = (m) => ($("status").textContent = m);
const excludeChecked = () => $("exclude").checked;

// Promise wrappers (callback style works in both Firefox and Chromium).
const getActiveTab = () =>
  new Promise((res) => chrome.tabs.query({ active: true, currentWindow: true }, (t) => res(t[0])));
const sendToTab = (tabId, msg) =>
  new Promise((res) =>
    chrome.tabs.sendMessage(tabId, msg, (r) => res(chrome.runtime.lastError ? null : r)),
  );

let tab = null;

function renderTiers(counts) {
  const wrap = $("tiers");
  wrap.innerHTML = "";
  for (const g of TIERS) {
    const n = counts?.[g] || 0;
    const label = document.createElement("label");
    label.innerHTML = `
      <input type="checkbox" value="${g}" ${n ? "" : "disabled"} />
      <span class="grade" style="background:${COLOR[g]}">${g}</span>
      <span class="count">${n}</span>`;
    wrap.appendChild(label);
  }
}

function selectedTiers() {
  return [...document.querySelectorAll('#tiers input:checked')].map((i) => i.value);
}

async function run(apply) {
  const tiers = selectedTiers();
  if (!tiers.length) return status("Pick at least one tier.");
  if (!tab) return status("Open DIM in this tab first.");
  const resp = await sendToTab(tab.id, { type: "tierSearch", tiers, apply, excludeExotics: excludeChecked() });
  if (!resp) return status("No response — is DIM open and loaded?");
  if (!resp.ok) return status(resp.error || "Vault still loading…");
  if (!resp.count) return status("No owned weapons in those tiers.");

  if (apply) {
    status(resp.applied ? `Applied — ${resp.count} weapons.` : "Couldn't find DIM's search box.");
  } else {
    try {
      await navigator.clipboard.writeText(resp.query);
      status(`Copied query — ${resp.count} weapons.`);
    } catch {
      status("Clipboard blocked; query in console.");
      console.log(resp.query);
    }
  }
}

let unmatched = [];

function applyCounts(resp) {
  renderTiers(resp?.counts || {});
  $("redundant-count").textContent = resp?.redundant ?? 0;
  $("redundant").checked = Boolean(resp?.highlightOn);
  const cov = resp?.coverage;
  unmatched = cov?.unmatched || [];
  $("coverage").textContent = cov
    ? `On tier list: ${cov.matched}/${cov.ownedWeapons} owned weapons` +
      (unmatched.length ? ` · click to copy ${unmatched.length} unmatched` : "")
    : "";
  const d = resp?.debug;
  $("debug").textContent = d
    ? `build ${d.build} · ${d.instances} items · ${d.tiers} tiered · ${d.dupGroups} dup groups · keep ${d.keepers} · mint:${d.mintKnown ? "yes" : "no"}\n${d.probe || ""}${d.err ? `\nERR: ${d.err}` : ""}`
    : "";
  $("debug").style.whiteSpace = "pre-wrap";
  if (resp && !resp.ready) status("Vault still loading in DIM…");
}

async function copyUnmatched() {
  if (!unmatched.length) return;
  try {
    await navigator.clipboard.writeText(unmatched.join("\n"));
    status(`Copied ${unmatched.length} unmatched names.`);
  } catch {
    console.log(unmatched.join("\n"));
    status("Unmatched names in console.");
  }
}

async function toggleRedundant() {
  if (!tab) return status("Open DIM first.");
  const resp = await sendToTab(tab.id, {
    type: "highlightRedundant",
    on: $("redundant").checked,
    excludeExotics: excludeChecked(),
  });
  if (!resp) return status("No response — is DIM open and loaded?");
  $("redundant-count").textContent = resp.redundant ?? 0;
  status($("redundant").checked ? `Highlighting ${resp.redundant} redundant rolls.` : "Highlighting off.");
}

async function runRedundant(apply) {
  if (!tab) return status("Open DIM first.");
  const resp = await sendToTab(tab.id, { type: "redundantSearch", apply, excludeExotics: excludeChecked() });
  if (!resp) return status("No response — is DIM open and loaded?");
  if (!resp.instances) return status("No redundant rolls found.");
  if (apply) {
    $("redundant").checked = Boolean(resp.highlightOn);
    status(resp.applied ? `${resp.weapons} weapons, ${resp.instances} shardable copies.` : "Couldn't find DIM's search box.");
  } else {
    try {
      await navigator.clipboard.writeText(resp.query);
      status(`Copied — ${resp.weapons} weapons.`);
    } catch {
      status("Clipboard blocked; query in console.");
      console.log(resp.query);
    }
  }
}

async function refresh() {
  if (!tab) return;
  applyCounts(await sendToTab(tab.id, { type: "tierCounts", excludeExotics: excludeChecked() }));
}

async function init() {
  tab = await getActiveTab();
  const resp = tab && (await sendToTab(tab.id, { type: "tierCounts", excludeExotics: excludeChecked() }));
  if (!resp) {
    status("Open DIM to use this.");
    renderTiers({});
    return;
  }
  applyCounts(resp);
}

$("apply").addEventListener("click", () => run(true));
$("copy").addEventListener("click", () => run(false));
$("exclude").addEventListener("change", refresh);
$("redundant").addEventListener("change", toggleRedundant);
$("redundant-apply").addEventListener("click", () => runRedundant(true));
$("redundant-copy").addEventListener("click", () => runRedundant(false));
$("coverage").addEventListener("click", copyUnmatched);
init();
