// Background service worker:
//  - desktop notifications, plus a phone push through ntfy when a topic is set;
//  - the check timer: chrome.alarms fires on time even when the tab is in the
//    background, where Chrome would otherwise hold page timers to whole
//    minutes and make reloads land at the same second every time;
//  - a stall check: when a tab's check was due 15+ minutes ago and hasn't
//    happened, reload the tab once (after the Mac wakes this is all it takes);
//    if checks still don't resume a few minutes later, warn.
//
// Each watching tab has a record in chrome.storage.session under "watch-<tabId>":
//   { nextCheckAt, stage: 0 | 1 (nudged) | 2 (warned), nudgedAt }
importScripts("schedule.js", "notify.js");

const STALL_ALARM = "stall-watch";
const WATCH_PREFIX = "watch-";

async function watchers() {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(WATCH_PREFIX))
    .map(([k, v]) => ({ key: k, tabId: Number(k.slice(WATCH_PREFIX.length)), ...v }));
}

// The stall timer only runs while some tab is being watched.
async function syncStallAlarm() {
  const any = (await watchers()).length > 0;
  const alarm = await chrome.alarms.get(STALL_ALARM);
  if (any && !alarm) await chrome.alarms.create(STALL_ALARM, { periodInMinutes: 5 });
  if (!any && alarm) await chrome.alarms.clear(STALL_ALARM);
}
chrome.runtime.onStartup.addListener(syncStallAlarm);

async function stopWatching(tabId) {
  await Promise.all([
    chrome.alarms.clear(`check-${tabId}`),
    chrome.storage.session.remove([`check-${tabId}`, `${WATCH_PREFIX}${tabId}`]),
  ]);
  await syncStallAlarm();
}

async function push({ topic, title, message, click, priority, tags }) {
  const saved = await chrome.storage.local.get({ ntfyTopic: "", ntfyServer: "https://ntfy.sh" });
  const req = buildNtfy({ server: saved.ntfyServer, topic: topic || saved.ntfyTopic, title, message, click, priority, tags });
  if (!req) return { ok: false, error: "No valid ntfy topic set" };
  try {
    const res = await fetch(req.url, req.init);
    return res.ok ? { ok: true } : { ok: false, error: `ntfy answered HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function desktop(id, title, message) {
  chrome.notifications.create(id, { type: "basic", iconUrl: "icon.png", title, message, priority: 2, requireInteraction: true });
}

const reply = (p, sendResponse) => p.then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (tabId == null) return;
  const name = `check-${tabId}`;

  switch (msg?.type) {
    case "duo-available": {
      const message = msg.lines.slice(0, 4).join("\n");
      desktop(`duo-${tabId}-${Date.now()}`, "iPhone Duo available for pickup!", message);
      push({ title: "iPhone Duo available for pickup!", message, click: msg.url, priority: 5, tags: ["iphone", "rotating_light"] });
      return;
    }
    case "duo-test-push":
      push({ topic: msg.topic, title: "Duo watcher test", message: "Phone alerts are working.", click: msg.url, priority: 3, tags: ["white_check_mark"] })
        .then(sendResponse);
      return true;
    case "duo-schedule":
      reply(chrome.storage.session.set({ [name]: msg.url || "", [`${WATCH_PREFIX}${tabId}`]: { nextCheckAt: msg.at, stage: 0 } })
        .then(() => chrome.alarms.create(name, { when: msg.at }))
        .then(syncStallAlarm), sendResponse);
      return true;
    case "duo-cancel":
      reply(stopWatching(tabId), sendResponse);
      return true;
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === STALL_ALARM) return checkStall();
  if (!alarm.name.startsWith("check-")) return;
  const tabId = Number(alarm.name.slice(6));
  const { [alarm.name]: url } = await chrome.storage.session.get(alarm.name);
  await chrome.storage.session.remove(alarm.name);
  try {
    if (url) await chrome.tabs.update(tabId, { url });
    else await chrome.tabs.reload(tabId);
  } catch (_) { /* tab was closed */ }
});

async function checkStall(now = Date.now()) {
  const { paused } = await chrome.storage.local.get({ paused: false });
  if (paused) return;
  for (const w of await watchers()) {
    const action = stallAction(now, w);
    if (action === "nudge") {
      await chrome.storage.session.set({ [w.key]: { nextCheckAt: w.nextCheckAt, stage: 1, nudgedAt: now } });
      try { await chrome.tabs.reload(w.tabId); } catch (_) { /* tab is gone; the next pass warns */ }
    } else if (action === "warn") {
      await chrome.storage.session.set({ [w.key]: { nextCheckAt: w.nextCheckAt, nudgedAt: w.nudgedAt, stage: 2 } });
      const due = new Date(w.nextCheckAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const message = `A check was due at ${due} and reloading the tab didn't restart it. Make sure Chrome is open and the Apple tab is still there.`;
      desktop(`stall-${w.tabId}-${now}`, "Duo watcher stopped checking", message);
      await push({ title: "Duo watcher stopped checking", message, priority: 4, tags: ["warning"] });
    }
  }
}

// Closing the watched tab on purpose isn't a stall.
chrome.tabs.onRemoved.addListener((tabId) => { stopWatching(tabId); });

chrome.notifications.onClicked.addListener((id) => {
  if (!id.startsWith("duo-")) return;
  const tabId = Number(id.split("-")[1]);
  if (!tabId) return;
  chrome.tabs.update(tabId, { active: true }, (tab) => {
    void chrome.runtime.lastError;
    if (tab) chrome.windows.update(tab.windowId, { focused: true });
  });
});

if (typeof module !== "undefined") module.exports = { checkStall, syncStallAlarm, push };
