// Reads the pickup data the page received (via hook.js), shows a status badge,
// alerts on availability, keeps a check history, and moves to the next check
// on a jittered timer (reloading this page, or loading the next watched model).
(() => {
  const DEFAULTS = {
    paused: false, intervalMin: 5,
    // Peak mode: check every minute from 8:45 to 10:30 AM local time.
    peakEnabled: true, peakStartMin: 8 * 60 + 45, peakEndMin: 10 * 60 + 30, peakIntervalMin: 1,
    // Night (10 PM until the peak): at least this many minutes between checks.
    nightStartMin: 22 * 60, nightMinIntervalMin: 10,
    // After Apple blocks a check: no checks until blockedUntil, then slower until recoverUntil.
    blockStreak: 0, blockedUntil: 0, recoverUntil: 0,
    watchList: [],      // model slugs to rotate through; empty = just this page
    ignoredStores: [],  // store names that never trigger an alert
    resumeAfterHitMin: 5, // 0 = stop after an alert
    ntfyTopic: "",      // phone push topic (see notify.js)
    ntfyDraft: "",      // what's in the topic box before it's saved (survives reloads)
    detailsOpen: false,
  };
  const NO_DATA_HINT_MS = 45_000;
  // The background alarm normally does the reload; if it hasn't by this long
  // after the due time (or isn't available), the page reloads itself.
  const FALLBACK_GRACE_MS = 90_000;
  const HISTORY_ROWS_SHOWN = 15;

  // If Chrome is still using an older manifest (extension not reloaded after
  // an update), helper files may be missing. Fall back instead of stopping.
  const SCHEDULE_OK = typeof nextReload === "function";
  const HELPERS_OK = SCHEDULE_OK && typeof parseModelPage === "function" && typeof splitIgnored === "function"
    && typeof validNtfyTopic === "function";
  const nextReloadSafe = SCHEDULE_OK ? nextReload
    : (now, s) => (s.blockedUntil || 0) > now.getTime()
      ? { delayMs: s.blockedUntil - now.getTime(), peak: false, resting: true }
      : { delayMs: s.intervalMin * 60_000 * (0.85 + Math.random() * 0.3), peak: false, resting: false };
  const onBlockedSafe = SCHEDULE_OK ? onBlocked
    : (now, s) => ({ blockStreak: (s.blockStreak || 0) + 1, blockedUntil: now.getTime() + 60 * 60_000, recoverUntil: 0 });
  const onCheckOkSafe = SCHEDULE_OK ? onCheckOk
    : (_now, s) => (s.blockStreak || s.blockedUntil ? { blockStreak: 0, blockedUntil: 0, recoverUntil: 0 } : null);
  const baseIntervalSafe = SCHEDULE_OK ? baseIntervalMin : (_now, s) => s.intervalMin;
  const fmtClockSafe = typeof fmtClock === "function" ? fmtClock : (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

  const page = HELPERS_OK ? parseModelPage(location.href) : null; // { slug, carrier } or null
  const pageLabel = page ? modelLabel(page.slug) : "this page";

  let settings = { ...DEFAULTS };
  let history = [];
  let hits = [];        // "available" checks only, kept longer than the log
  let reloadAt = null;
  let nextIsPeak = false;
  let resting = false;
  let alarmOk = false;   // background alarm confirmed for the current reloadAt
  let blockedThisLoad = false;
  let found = false;
  let hitResumeAt = null; // after an alert: when to start checking again
  let gotPickupData = false;
  let loggedThisLoad = false;
  let loggedHitThisLoad = false;
  let statusText = "Waiting for the page to check pickup availability…";
  let statusKind = "info"; // info | ok | warn | hit
  let whereText = "";
  let whereWarn = false;
  let badge;

  const store = {
    load: () => new Promise((r) => chrome.storage.local.get({ ...DEFAULTS, history: [], hits: null }, (v) => r(v))),
    save: (patch) => { settings = { ...settings, ...patch }; chrome.storage.local.set(patch); },
  };

  // Models currently being watched (falls back to just this page).
  function watched() {
    if (settings.watchList.length) return settings.watchList;
    return page ? [page.slug] : [];
  }

  function log(entry) {
    if (!HELPERS_OK) return;
    const e = { t: Date.now(), model: pageLabel, ...entry };
    history = addHistory(history, e);
    if (e.result === "available") {
      hits = addHistory(hits, e, HITS_MAX);
      chrome.storage.local.set({ history, hits });
    } else {
      chrome.storage.local.set({ history });
    }
    render();
  }

  // ---------- incoming data from the page ----------
  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d?.__duoWatcher) return;

    if (d.status < 200 || d.status >= 300) {
      // Apple refused this check (541 = its bot protection). Retrying soon
      // keeps the block going, so stop checking for a good while.
      // The page may retry on its own; count one block per page load.
      if (blockedThisLoad) return;
      blockedThisLoad = true;
      store.save(onBlockedSafe(new Date(), settings));
      setStatus(`Apple blocked the availability check (HTTP ${d.status}). Resting until ${fmtTime(settings.blockedUntil)} so the block can clear.`, "warn");
      if (!loggedThisLoad) { loggedThisLoad = true; log({ result: "blocked", note: `HTTP ${d.status}` }); }
      schedule();
      return;
    }

    let json;
    try { json = JSON.parse(d.body); } catch { return; }
    const r = parseFulfillment(json);
    if (!d.url.includes("pl=true") && r.storesChecked === 0) return; // delivery-only call; ignore

    let params;
    try { params = new URL(d.url, location.origin).searchParams; } catch { params = new URLSearchParams(); }
    const zip = params.get("location") || r.location || ""; // a ZIP or a store name

    gotPickupData = true;
    const cleared = onCheckOkSafe(new Date(), settings);
    if (cleared) store.save(cleared);
    // Prefer the model named in the response over the page URL.
    const label = (HELPERS_OK && modelForPart((r.stores || [])[0]?.part)?.label) || pageLabel;

    const names = [...new Set((r.stores || []).map((s) => s.store))];
    const loc = HELPERS_OK ? locationLabel(zip, names) : zip ? `ZIP ${zip}` : "";
    whereText = names.length ? `Checking: ${names.join(", ")}${loc ? ` · ${loc}` : ""}` : loc;
    whereWarn = names.length === 1;

    const split = HELPERS_OK ? splitIgnored(r.available, settings.ignoredStores) : { alert: r.available, ignored: [] };
    if (r.available.length) {
      const note = `${r.available[0].quote}${split.alert.length ? "" : " (ignored store)"}`;
      // Always log stock, even if something else was logged earlier this load.
      if (!loggedHitThisLoad) log({ model: label, result: "available", stores: r.available.map((a) => a.store), zip, note });
      loggedThisLoad = loggedHitThisLoad = true;
      if (split.alert.length) {
        onFound({ ...r, available: split.alert }, label);
      } else {
        const at = [...new Set(split.ignored.map((a) => a.store))].join(", ");
        setStatus(`${label}: available only at ${at}, which you've chosen to ignore. Still watching.`, "ok");
        schedule();
      }
    } else if (r.storesChecked === 0) {
      setStatus("No stores in the pickup results. Use “Check availability” on this page to pick your ZIP/store once.", "warn");
      if (!loggedThisLoad) { loggedThisLoad = true; log({ model: label, result: "nodata", zip, note: "no stores in results" }); }
      schedule();
    } else {
      const deliv = r.delivery ? ` Delivery: ${r.delivery}.` : "";
      setStatus(`${label}: not available at ${names.length} store${names.length === 1 ? "" : "s"}.${deliv}`, "ok");
      if (!loggedThisLoad) { loggedThisLoad = true; log({ model: label, result: "none", stores: names, zip }); }
      schedule();
    }
  });

  function onFound(r, label = pageLabel) {
    if (found) return;
    found = true;
    const resumeMin = Number(settings.resumeAfterHitMin) || 0;
    hitResumeAt = resumeMin > 0 ? Date.now() + resumeMin * 60_000 : null;
    const lines = r.available.map((a) => `${a.store}${a.city ? ` (${a.city})` : ""}: ${a.quote || "available"}`);
    const then = hitResumeAt ? `Checking again in ${resumeMin} min (Pause to stay on this page).` : "Auto-reload stopped so you can reserve.";
    setStatus(`AVAILABLE — ${label} — ${lines.join(" · ")}. ${then}`, "hit");
    send({ type: "duo-available", lines: [label, ...lines], url: location.href });
    schedule();
    beep();
    flashTitle();
  }

  // ---------- next check ----------
  function schedule() {
    if ((found && !hitResumeAt) || settings.paused) {
      reloadAt = null;
      alarmOk = false;
      send({ type: "duo-cancel" });
      render();
      return;
    }
    const next = found
      ? { delayMs: Math.max(0, hitResumeAt - Date.now()), peak: false, resting: false }
      : nextReloadSafe(new Date(), settings);
    nextIsPeak = next.peak;
    resting = !!next.resting;
    const at = Date.now() + next.delayMs;
    reloadAt = at;
    alarmOk = false;
    send({ type: "duo-schedule", at, url: nextCheckUrl() }, (res) => { if (reloadAt === at) alarmOk = !!res?.ok; });
    render();
  }

  function send(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; cb?.(res); });
    } catch (_) { cb?.(null); } // extension reloaded underneath this page
  }

  // URL of the next check ("" = reload this page).
  function nextCheckUrl() {
    const list = watched();
    if (page && list.length && !(list.length === 1 && list[0] === page.slug)) {
      const next = nextModelSlug(page.slug, list);
      if (next !== page.slug) return modelPageUrl(location.origin, next, page.carrier);
    }
    return "";
  }

  function goToNextCheck() {
    const url = nextCheckUrl();
    if (url) location.href = url; else location.reload();
  }

  setInterval(() => {
    const due = reloadAt && Date.now() >= reloadAt + (alarmOk ? FALLBACK_GRACE_MS : 0);
    if (due && !settings.paused && (!found || hitResumeAt)) {
      reloadAt = null;
      goToNextCheck();
    }
    renderCountdown();
  }, 1000);

  // ---------- alerts ----------
  function beep() {
    try {
      const ctx = new AudioContext();
      [0, 0.35, 0.7].forEach((t) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880; g.gain.value = 0.15;
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.2);
      });
    } catch (_) { /* audio may be blocked until you interact with the page */ }
  }

  function flashTitle() {
    const orig = document.title;
    let on = false;
    setInterval(() => { document.title = (on = !on) ? "🟢 AVAILABLE — iPhone Duo" : orig; }, 1000);
  }

  // ---------- badge UI ----------
  function setStatus(text, kind) { statusText = text; statusKind = kind; render(); }

  function fmt(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const ss = String(s % 60).padStart(2, "0");
    return s >= 3600
      ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${ss}`
      : `${Math.floor(s / 60)}:${ss}`;
  }

  function fmtTime(t) {
    const d = new Date(t);
    const today = new Date().toDateString() === d.toDateString();
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return today ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
  }

  const RESULT_ICON = { none: "–", available: "🟢", blocked: "⛔", nodata: "?" };

  function buildBadge() {
    badge = document.createElement("div");
    badge.attachShadow({ mode: "open" }).innerHTML = `
      <style>
        :host { all: initial; }
        .box { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 330px; max-height: calc(100vh - 32px); overflow: auto;
          font: 13px/1.4 -apple-system, BlinkMacSystemFont, sans-serif; color: #1d1d1f; box-sizing: border-box;
          background: #fff; border: 1px solid #d2d2d7; border-left: 4px solid var(--c, #0071e3);
          border-radius: 10px; box-shadow: 0 4px 18px rgba(0,0,0,.15); padding: 10px 12px; }
        .box[data-kind=ok] { --c: #8e8e93; } .box[data-kind=warn] { --c: #ff9f0a; }
        .box[data-kind=hit] { --c: #30d158; background: #eafbef; }
        .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
        h4 { margin: 0; font-size: 13px; } h5 { margin: 10px 0 4px; font-size: 12px; }
        .msg { margin: 0 0 4px; } .where { margin: 0 0 8px; color: #6e6e73; font-size: 12px; }
        .where.warn { color: #b25000; }
        .row { display: flex; gap: 8px; align-items: center; }
        .peak { display: flex; gap: 6px; align-items: center; margin-top: 8px; color: #6e6e73; cursor: pointer; }
        .next, .lbl { color: #6e6e73; flex: 1; }
        button, select { font: inherit; border: 1px solid #d2d2d7; border-radius: 6px; background: #f5f5f7; padding: 2px 8px; cursor: pointer; color: inherit; }
        .link { border: 0; background: none; padding: 0; color: #0066cc; }
        .details { border-top: 1px solid #e5e5ea; margin-top: 10px; padding-top: 2px; }
        .models, .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; }
        .models label, .grid label { display: flex; gap: 6px; align-items: center; cursor: pointer; }
        .muted { color: #6e6e73; font-size: 12px; margin: 4px 0 0; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
        td { padding: 2px 4px 2px 0; vertical-align: top; } td:first-child { white-space: nowrap; color: #6e6e73; }
        .hist-actions { display: flex; gap: 8px; margin-top: 6px; }
        .topic { font: inherit; flex: 1; min-width: 0; border: 1px solid #d2d2d7; border-radius: 6px; padding: 2px 6px; }
        .row + .row { margin-top: 4px; }
        .chart { display: flex; align-items: flex-end; gap: 2px; height: 48px; margin-top: 4px; }
        .chart div { flex: 1; background: #30d158; border-radius: 2px 2px 0 0; min-height: 1px; }
        .chart div.zero { background: #e5e5ea; }
        .axis { display: flex; justify-content: space-between; color: #6e6e73; font-size: 11px; }
      </style>
      <div class="box">
        <div class="head"><h4>Duo pickup watcher</h4><button class="link toggle"></button></div>
        <p class="msg"></p>
        <p class="where"></p>
        <div class="row"><span class="next"></span>
          <select class="interval" title="Check interval">${[1, 2, 3, 5, 10, 15].map((m) => `<option value="${m}">every ${m} min</option>`).join("")}</select>
          <button class="pause"></button></div>
        <label class="peak"><input type="checkbox"> <span></span></label>
        <p class="muted night"></p>
        <p class="muted"><button class="link retry">Check now instead of resting</button></p>
        <div class="details">
          <h5>Alerts</h5>
          <div class="row"><span class="lbl">After an alert</span>
            <select class="resume">${[[0, "stop checking"], [3, "check again in 3 min"], [5, "check again in 5 min"], [10, "check again in 10 min"]]
              .map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select></div>
          <p class="muted">Phone alerts: install the ntfy app, subscribe to a topic, and enter the same topic here. Anyone who knows the topic can read it, so keep the random one.</p>
          <div class="row"><input class="topic" type="text" spellcheck="false" autocomplete="off"><button class="test-push">Save &amp; test</button></div>
          <p class="muted push-status"></p>
          <h5>Alert for these stores</h5>
          <div class="grid stores"></div>
          <p class="muted stores-hint"></p>
          <h5>Models to watch</h5>
          <div class="models">${HELPERS_OK ? DUO_MODELS.map((m) => `<label><input type="checkbox" value="${m.slug}"> ${m.label}</label>`).join("") : ""}</div>
          <p class="muted rotation"></p>
          <h5>History</h5>
          <p class="muted summary"></p>
          <p class="muted chart-title"></p>
          <div class="chart"></div>
          <div class="axis"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>11 PM</span></div>
          <table><tbody class="hist"></tbody></table>
          <div class="hist-actions"><button class="csv">Download CSV</button><button class="clear">Clear history</button></div>
        </div>
      </div>`;
    const root = badge.shadowRoot;
    root.querySelector(".interval").addEventListener("change", (e) => { store.save({ intervalMin: Number(e.target.value) }); schedule(); });
    root.querySelector(".pause").addEventListener("click", () => { store.save({ paused: !settings.paused }); schedule(); });
    root.querySelector(".peak input").addEventListener("change", (e) => { store.save({ peakEnabled: e.target.checked }); schedule(); });
    root.querySelector(".retry").addEventListener("click", () => {
      // Keeps blockStreak, so another block right away rests longer.
      store.save({ blockedUntil: 0 });
      reloadAt = null;
      goToNextCheck();
    });
    root.querySelector(".resume").addEventListener("change", (e) => { store.save({ resumeAfterHitMin: Number(e.target.value) }); });
    const topic = root.querySelector(".topic");
    // The page reloads every few minutes, so keep the suggestion (and anything
    // typed) in storage rather than making up a new topic on each load.
    if (!settings.ntfyTopic && !settings.ntfyDraft && HELPERS_OK) store.save({ ntfyDraft: randomNtfyTopic() });
    topic.value = settings.ntfyDraft || settings.ntfyTopic;
    topic.addEventListener("input", () => store.save({ ntfyDraft: topic.value.trim() }));
    root.querySelector(".test-push").addEventListener("click", () => {
      const st = root.querySelector(".push-status");
      const t = topic.value.trim();
      if (!t) { store.save({ ntfyTopic: "", ntfyDraft: "" }); st.textContent = "Phone alerts off."; return; }
      if (!validNtfyTopic(t)) { st.textContent = "Use 8–64 letters, numbers, - or _."; return; }
      store.save({ ntfyTopic: t, ntfyDraft: t });
      st.textContent = "Sending a test…";
      // Pass the topic along: the storage write above may not have landed yet.
      send({ type: "duo-test-push", topic: t, url: location.href }, (res) => {
        st.textContent = res?.ok ? `Sent to “${t}”. Check your phone.` : `Couldn't send: ${res?.error || "extension not reachable, reload it in chrome://extensions"}.`;
      });
    });
    root.querySelector(".stores").addEventListener("change", (e) => {
      if (!e.target.matches("input")) return;
      const ignored = new Set(settings.ignoredStores);
      e.target.checked ? ignored.delete(e.target.value) : ignored.add(e.target.value);
      store.save({ ignoredStores: [...ignored].sort() });
      render();
    });
    root.querySelector(".toggle").addEventListener("click", () => { store.save({ detailsOpen: !settings.detailsOpen }); render(); });
    root.querySelectorAll(".models input").forEach((cb) => cb.addEventListener("change", () => {
      const list = [...root.querySelectorAll(".models input")].filter((x) => x.checked).map((x) => x.value);
      store.save({ watchList: list });
      render();
    }));
    root.querySelector(".csv").addEventListener("click", () => {
      const url = URL.createObjectURL(new Blob([historyToCsv(history)], { type: "text/csv" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: `duo-watcher-history-${new Date().toISOString().slice(0, 10)}.csv` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    root.querySelector(".clear").addEventListener("click", () => {
      if (!confirm("Clear the check history and the restock chart?")) return;
      history = [];
      hits = [];
      chrome.storage.local.set({ history, hits });
      render();
    });
    document.documentElement.appendChild(badge);
  }

  function renderCountdown() {
    if (!badge) return;
    badge.shadowRoot.querySelector(".next").textContent =
      settings.paused ? "Paused" :
      found ? (hitResumeAt ? `Checking again in ${fmt(hitResumeAt - Date.now())}` : "Stopped") :
      reloadAt ? `Next check in ${fmt(reloadAt - Date.now())}${resting ? " (resting)" : nextIsPeak ? " (peak)" : ""}` : "";
    badge.shadowRoot.querySelector(".retry").style.display = resting && !found && !settings.paused ? "" : "none";
  }

  function render() {
    if (!badge) return;
    const r = badge.shadowRoot;
    r.querySelector(".box").dataset.kind = statusKind;
    r.querySelector(".msg").textContent = statusText;
    const where = r.querySelector(".where");
    where.textContent = whereText + (whereWarn ? " — only 1 store. Re-enter your ZIP under “Check availability” to include more." : "");
    where.classList.toggle("warn", whereWarn);
    where.style.display = whereText ? "" : "none";
    r.querySelector(".interval").value = String(settings.intervalMin);
    r.querySelector(".pause").textContent = settings.paused ? "Resume" : "Pause";
    r.querySelector(".peak input").checked = settings.peakEnabled;
    r.querySelector(".peak span").textContent = !SCHEDULE_OK
      ? "⚠ Peak mode is off: open chrome://extensions and click reload on this extension, then refresh this tab."
      : `Peak mode: every ${settings.peakIntervalMin} min, ${fmtClockSafe(settings.peakStartMin)}–${fmtClockSafe(settings.peakEndMin)}`;
    r.querySelector(".night").textContent = SCHEDULE_OK && settings.nightMinIntervalMin
      ? `Night, ${fmtClockSafe(settings.nightStartMin)}–${fmtClockSafe(settings.peakStartMin)}: at most every ${settings.nightMinIntervalMin} min.`
      : "";
    renderCountdown();

    r.querySelector(".toggle").textContent = settings.detailsOpen ? "Hide details" : "Details";
    r.querySelector(".details").style.display = settings.detailsOpen ? "" : "none";
    if (!settings.detailsOpen || !HELPERS_OK) return;

    // Alerts
    r.querySelector(".resume").value = String(settings.resumeAfterHitMin);
    r.querySelector(".push-status").textContent ||= settings.ntfyTopic ? `Phone alerts on (topic “${settings.ntfyTopic}”).` : "Phone alerts off.";
    const storeNames = [...new Set([...knownStores(history), ...knownStores(hits), ...settings.ignoredStores])].sort();
    const storesBox = r.querySelector(".stores");
    if (storesBox.dataset.names !== storeNames.join("|")) {
      storesBox.dataset.names = storeNames.join("|");
      storesBox.replaceChildren(...storeNames.map((n) => {
        const l = document.createElement("label"), cb = document.createElement("input");
        cb.type = "checkbox"; cb.value = n;
        l.append(cb, ` ${n}`);
        return l;
      }));
    }
    storesBox.querySelectorAll("input").forEach((cb) => { cb.checked = !settings.ignoredStores.includes(cb.value); });
    r.querySelector(".stores-hint").textContent = storeNames.length
      ? "Untick a store to skip its alerts (it's still logged)."
      : "Stores appear here once a check has seen them.";

    // Models
    const list = watched();
    r.querySelectorAll(".models input").forEach((cb) => { cb.checked = list.includes(cb.value); });
    const per = Math.round(baseIntervalSafe(new Date(), settings) * Math.max(1, list.length) * 10) / 10;
    r.querySelector(".rotation").textContent = !page
      ? "Open an iPhone Duo model page to use model rotation."
      : list.length > 1
        ? `Rotating through ${list.length} models (${page.carrier}). Each one is checked about every ${per} min right now.`
        : `Watching ${list.length ? modelLabel(list[0]) : pageLabel} (${page.carrier}). Tick more to rotate through them.`;

    // History
    const s = summarizeHistory(history);
    const last = s.lastAvailable
      ? ` Last seen available: ${fmtTime(s.lastAvailable.t)}, ${s.lastAvailable.model} at ${(s.lastAvailable.stores || []).join(", ")}.`
      : "";
    r.querySelector(".summary").textContent =
      `Today: ${s.checks} checks · ${s.available} available · ${s.blocked} blocked · ${s.nodata} no data.${last}`;
    const byHour = hitsByHour(hits, settings.ignoredStores);
    const total = byHour.reduce((a, b) => a + b, 0);
    const max = Math.max(1, ...byHour);
    const since = Math.min(hits[0]?.t ?? Infinity, history[0]?.t ?? Infinity);
    r.querySelector(".chart-title").textContent = total
      ? `Restocks by hour of day (${total} since ${fmtTime(since)}, not counting ignored stores):`
      : "No availability in the log yet. A chart of when stock appears will show here.";
    r.querySelector(".chart").style.display = r.querySelector(".axis").style.display = total ? "" : "none";
    r.querySelector(".chart").replaceChildren(...byHour.map((n, h) => {
      const bar = document.createElement("div");
      bar.style.height = `${(n / max) * 100}%`;
      bar.className = n ? "" : "zero";
      bar.title = `${fmtClockSafe(h * 60)}: ${n}`;
      return bar;
    }));
    const tbody = r.querySelector(".hist");
    tbody.replaceChildren(...history.slice(-HISTORY_ROWS_SHOWN).reverse().map((e) => {
      const tr = document.createElement("tr");
      const what = e.result === "available" ? `available at ${(e.stores || []).join(", ")}`
        : e.result === "blocked" ? `blocked (${e.note || ""})`
        : e.result === "nodata" ? "no pickup data"
        : `none at ${(e.stores || []).length} store${(e.stores || []).length === 1 ? "" : "s"}`;
      [fmtTime(e.t), RESULT_ICON[e.result] || "", `${e.model}: ${what}`].forEach((txt) => {
        const td = document.createElement("td"); td.textContent = txt; tr.appendChild(td);
      });
      return tr;
    }));
  }

  // ---------- start ----------
  store.load().then((s) => {
    const { history: h, hits: hl, ...rest } = s;
    settings = { ...DEFAULTS, ...rest };
    history = Array.isArray(h) ? h : [];
    // First run with a separate hit list: start it from the log.
    hits = Array.isArray(hl) ? hl : history.filter((e) => e.result === "available");
    const start = () => {
      buildBadge();
      render();
      setTimeout(() => {
        if (!gotPickupData && !found && statusKind === "info") {
          setStatus("No pickup check seen yet. Use “Check availability” on this page to choose your store, or Apple may be blocking the check.", "warn");
          if (!loggedThisLoad) { loggedThisLoad = true; log({ result: "nodata", note: "no pickup check seen" }); }
          schedule();
        }
      }, NO_DATA_HINT_MS);
    };
    document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", start) : start();
  });
})();
