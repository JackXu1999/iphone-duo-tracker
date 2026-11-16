// Runs background.js against a small fake of the chrome.* APIs it uses.
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeChrome() {
  const area = () => {
    const d = {};
    return {
      _d: d,
      async get(keys) {
        if (keys == null) return { ...d };
        if (typeof keys === "string") return keys in d ? { [keys]: d[keys] } : {};
        if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in d).map((k) => [k, d[k]]));
        return Object.fromEntries(Object.entries(keys).map(([k, def]) => [k, k in d ? d[k] : def]));
      },
      async set(p) { Object.assign(d, p); },
      async remove(keys) { for (const k of [].concat(keys)) delete d[k]; },
    };
  };
  const listeners = {};
  const on = (name) => ({ addListener: (f) => { listeners[name] = f; } });
  const alarms = {};
  const log = { notifications: [], reloads: [], updates: [], fetches: [] };
  const chrome = {
    storage: { local: area(), session: area() },
    alarms: {
      async get(n) { return alarms[n]; },
      async create(n, o) { alarms[n] = { name: n, ...o }; },
      async clear(n) { const had = n in alarms; delete alarms[n]; return had; },
      onAlarm: on("alarm"),
    },
    runtime: { onMessage: on("message"), onStartup: on("startup"), onInstalled: on("installed") },
    tabs: {
      async reload(id) { if (id === 404) throw new Error("No tab"); log.reloads.push(id); },
      async update(id, p) { log.updates.push([id, p]); },
      onRemoved: on("removed"),
    },
    notifications: { create(id, o) { log.notifications.push({ id, ...o }); }, onClicked: on("notifClick") },
  };
  return { chrome, listeners, alarms, log };
}

function load() {
  const t = makeChrome();
  const root = path.join(__dirname, "..");
  const ctx = vm.createContext({
    chrome: t.chrome, console, URL, Date, Promise,
    module: { exports: {} },
    fetch: async (url, init) => { t.log.fetches.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; },
  });
  ctx.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), ctx);
  };
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), ctx);
  const send = (tabId, msg) => new Promise((resolve) => {
    const keepOpen = t.listeners.message(msg, { tab: { id: tabId } }, resolve);
    if (!keepOpen) resolve(undefined);
  });
  return { ...t, send, bg: ctx.module.exports };
}

(async () => {
  const MIN = 60_000;

  // Test push uses the topic sent with the message, even before storage has it.
  {
    const t = load();
    const res = await t.send(1, { type: "duo-test-push", topic: "duo-fresh12345", url: "https://www.apple.com/x" });
    assert.deepEqual(res, { ok: true });
    assert.equal(t.log.fetches[0].body.topic, "duo-fresh12345");
    assert.deepEqual(await t.send(1, { type: "duo-test-push", topic: "" }), { ok: false, error: "No valid ntfy topic set" });
  }

  // Scheduling creates the check alarm, a per-tab record and the stall timer; cancelling removes them.
  {
    const t = load();
    const at = Date.now() + 2 * MIN;
    assert.deepEqual(await t.send(7, { type: "duo-schedule", at, url: "" }), { ok: true });
    assert.equal(t.alarms["check-7"].when, at);
    assert.ok(t.alarms["stall-watch"]);
    assert.equal(t.chrome.storage.session._d["watch-7"].nextCheckAt, at);
    await t.send(8, { type: "duo-schedule", at, url: "" });
    await t.send(7, { type: "duo-cancel" });
    assert.equal(t.chrome.storage.session._d["watch-7"], undefined);
    assert.ok(t.chrome.storage.session._d["watch-8"], "the other tab keeps its record");
    assert.ok(t.alarms["stall-watch"], "stall timer stays while tab 8 is watched");
    await t.listeners.removed(8);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(t.alarms["stall-watch"], undefined, "no watched tabs: stall timer stops");
  }

  // Stalled tab: first reload it (Mac woke up); warn only if checks still don't resume.
  {
    const t = load();
    const due = Date.now();
    await t.send(5, { type: "duo-schedule", at: due, url: "" });
    await t.bg.checkStall(due + 10 * MIN);
    assert.equal(t.log.reloads.length, 0, "not stalled yet");
    await t.bg.checkStall(due + 16 * MIN);
    assert.deepEqual(t.log.reloads, [5]);
    assert.equal(t.log.notifications.length, 0, "no warning on the first pass");
    // The reload worked: the page scheduled its next check, so no warning.
    await t.send(5, { type: "duo-schedule", at: due + 18 * MIN, url: "" });
    await t.bg.checkStall(due + 21 * MIN);
    assert.equal(t.log.notifications.length, 0);
  }
  {
    const t = load();
    const due = Date.now();
    await t.chrome.storage.local.set({ ntfyTopic: "duo-phone123456" });
    await t.send(404, { type: "duo-schedule", at: due, url: "" }); // tab that can't be reloaded
    await t.bg.checkStall(due + 16 * MIN);
    await t.bg.checkStall(due + 18 * MIN);
    assert.equal(t.log.notifications.length, 0, "waits a few minutes after the nudge");
    await t.bg.checkStall(due + 21 * MIN);
    assert.equal(t.log.notifications.length, 1);
    assert.match(t.log.notifications[0].title, /stopped checking/);
    assert.equal(t.log.fetches.at(-1).body.topic, "duo-phone123456");
    await t.bg.checkStall(due + 26 * MIN);
    assert.equal(t.log.notifications.length, 1, "warns once");
  }
  // Paused: no nudges or warnings.
  {
    const t = load();
    await t.chrome.storage.local.set({ paused: true });
    await t.send(3, { type: "duo-schedule", at: Date.now(), url: "" });
    await t.bg.checkStall(Date.now() + 30 * MIN);
    assert.equal(t.log.reloads.length + t.log.notifications.length, 0);
  }

  console.log("all background tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
