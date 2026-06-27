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
  const resp = await sendToTab(tab.id, { type: "tierSearch", tiers, apply });
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

async function init() {
  tab = await getActiveTab();
  const onDim = tab && /app\.destinyitemmanager\.com/.test(tab.url || "");
  if (!onDim) {
    // url may be hidden without the tabs permission — try messaging anyway.
    const resp = tab && (await sendToTab(tab.id, { type: "tierCounts" }));
    if (!resp) {
      status("Open DIM to use this.");
      renderTiers({});
      return;
    }
    renderTiers(resp.counts);
    if (!resp.ready) status("Vault still loading in DIM…");
    return;
  }
  const resp = await sendToTab(tab.id, { type: "tierCounts" });
  renderTiers(resp?.counts || {});
  if (resp && !resp.ready) status("Vault still loading in DIM…");
}

$("apply").addEventListener("click", () => run(true));
$("copy").addEventListener("click", () => run(false));
init();
