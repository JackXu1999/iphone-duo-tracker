// A small rolling log of checks, kept in chrome.storage.local.
// Each entry: { t, model, result, stores, zip, note }
//   result: "none" | "available" | "blocked" | "nodata"

const HISTORY_MAX = 1000; // the full log is rewritten on every check, so keep it modest
// "Available" checks are also kept in their own list, written only when stock
// shows up, so the restock chart can look back much further than the log.
const HITS_MAX = 1000;
const SAME_RESTOCK_MS = 15 * 60_000;

function addHistory(list, entry, max = HISTORY_MAX) {
  const next = [...(list || []), entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

// Counts for checks since a given time (default: start of today, local).
function summarizeHistory(list, since) {
  const start = since ?? new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const out = { checks: 0, available: 0, blocked: 0, nodata: 0, lastAvailable: null };
  for (const e of list || []) {
    if (e.result === "available" && (!out.lastAvailable || e.t > out.lastAvailable.t)) out.lastAvailable = e;
    if (e.t < start) continue;
    out.checks++;
    if (e.result === "available") out.available++;
    else if (e.result === "blocked") out.blocked++;
    else if (e.result === "nodata") out.nodata++;
  }
  return out;
}

function historyToCsv(list) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = (list || []).map((e) =>
    [new Date(e.t).toISOString(), e.model, e.result, (e.stores || []).join("; "), e.zip, e.note].map(esc).join(","));
  return ["time,model,result,stores,location,note", ...rows].join("\n");
}

// Splits available stores into ones to alert for and ones the user ignores.
function splitIgnored(available, ignored) {
  const skip = new Set(ignored || []);
  const out = { alert: [], ignored: [] };
  for (const a of available || []) (skip.has(a.store) ? out.ignored : out.alert).push(a);
  return out;
}

// Every store name seen in the history, sorted.
function knownStores(list) {
  const names = new Set();
  for (const e of list || []) for (const s of e.stores || []) names.add(s);
  return [...names].sort();
}

// Restocks per local hour of day (0-23). Checks that keep finding stock at the
// same store within 15 minutes count once, and hits only at ignored stores
// don't count.
function hitsByHour(list, ignored = []) {
  const out = new Array(24).fill(0);
  const skip = new Set(ignored);
  const lastSeen = new Map(); // store -> time of its last "available" check
  for (const e of [...(list || [])].sort((a, b) => a.t - b.t)) {
    if (e.result !== "available") continue;
    const stores = (e.stores || []).filter((s) => !skip.has(s));
    if (!stores.length && (e.stores || []).length) continue;
    const isNew = !stores.length || stores.some((s) => !(e.t - (lastSeen.get(s) ?? -Infinity) <= SAME_RESTOCK_MS));
    for (const s of stores) lastSeen.set(s, e.t);
    if (isNew) out[new Date(e.t).getHours()]++;
  }
  return out;
}

// Apple's "location" is a ZIP or a store name ("Apple West 14th Street").
// Returns a short label, or "" when it only repeats a store already listed.
function locationLabel(loc, storeNames = []) {
  const v = String(loc || "").trim();
  if (!v) return "";
  if (/^\d{5}(-\d{4})?$/.test(v)) return `ZIP ${v}`;
  const bare = v.replace(/^Apple\s+/i, "");
  return storeNames.includes(bare) ? "" : `near ${bare}`;
}

if (typeof module !== "undefined") module.exports = { addHistory, summarizeHistory, historyToCsv, splitIgnored, knownStores, hitsByHour, locationLabel, HISTORY_MAX, HITS_MAX };
