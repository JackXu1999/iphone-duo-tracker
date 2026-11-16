// Decides when the page should reload next.
// Restock data shows most iPhone Duo store drops land around 9-10 AM local
// time and sell out in about a minute, so during a morning "peak" window we
// check every minute, and slowly the rest of the day.
//
// The check log showed Apple's bot protection (HTTP 541) kicking in after a
// few hours of checks every 1-2 minutes late at night, and that retrying every
// 30 minutes kept the block going. So:
//  - at night, checks are spaced out to at least nightMinIntervalMin;
//  - after a block, the watcher rests (no checks at all) until the next peak
//    window, or for 1, 2, 4, then 8 hours if blocks keep happening;
//  - for an hour after a block clears, checks stay at least 3 minutes apart.

const MS_MIN = 60_000;
const REST_MIN = [60, 120, 240, 480];   // rest after the 1st, 2nd, 3rd, 4th+ block in a row
const RECOVER_MS = 60 * MS_MIN;          // slower checks for this long after a block clears
const RECOVER_MIN_INTERVAL = 3;

function minutesOfDay(d) {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

function inPeak(now, s) {
  if (!s.peakEnabled) return false;
  const m = minutesOfDay(now);
  return m >= s.peakStartMin && m < s.peakEndMin;
}

// Night runs from nightStartMin to the start of the peak window (8:45 AM).
function inNight(now, s) {
  if (s.nightStartMin == null || !s.nightMinIntervalMin) return false;
  const m = minutesOfDay(now);
  const end = s.peakStartMin ?? 8 * 60 + 45;
  return s.nightStartMin > end ? m >= s.nightStartMin || m < end : m >= s.nightStartMin && m < end;
}

// Milliseconds until the next start of the peak window (today or tomorrow).
function msUntilPeakStart(now, s) {
  const start = new Date(now);
  start.setHours(Math.floor(s.peakStartMin / 60), s.peakStartMin % 60, 0, 0);
  if (start <= now) start.setDate(start.getDate() + 1);
  return start - now;
}

// The interval (in minutes) that applies right now.
function baseIntervalMin(now, s) {
  let min = inPeak(now, s) ? s.peakIntervalMin : s.intervalMin;
  if (!inPeak(now, s) && inNight(now, s)) min = Math.max(min, s.nightMinIntervalMin);
  if ((s.recoverUntil || 0) > now.getTime()) min = Math.max(min, RECOVER_MIN_INTERVAL);
  return min;
}

function isResting(now, s) {
  return (s.blockedUntil || 0) > now.getTime();
}

// Returns { delayMs, peak, resting } for the next reload.
function nextReload(now, s, rand = Math.random) {
  if (isResting(now, s)) {
    // Up to 2 extra minutes so the first check after a rest isn't on the dot.
    return { delayMs: Math.round(s.blockedUntil - now.getTime() + rand() * 2 * MS_MIN), peak: false, resting: true };
  }
  const peak = inPeak(now, s);
  let delayMs = baseIntervalMin(now, s) * MS_MIN * (1 + (rand() * 0.3 - 0.15)); // ±15% jitter

  // Outside the window, don't sleep past the start of the next peak.
  if (!peak && s.peakEnabled) {
    const untilPeak = msUntilPeakStart(now, s);
    if (untilPeak < delayMs) delayMs = untilPeak + rand() * 20_000;
  }
  return { delayMs: Math.round(delayMs), peak, resting: false };
}

// Settings patch to apply when Apple blocks a check.
function onBlocked(now, s) {
  const streak = (s.blockStreak || 0) + 1;
  let restMs = REST_MIN[Math.min(streak, REST_MIN.length) - 1] * MS_MIN;
  // Outside the peak, rest until the peak starts so the block has time to clear.
  if (s.peakEnabled && !inPeak(now, s)) restMs = Math.max(restMs, msUntilPeakStart(now, s));
  return { blockStreak: streak, blockedUntil: now.getTime() + restMs, recoverUntil: 0 };
}

// Settings patch to apply after a successful check (null if nothing changes).
function onCheckOk(now, s) {
  if (!s.blockStreak && !s.blockedUntil) return null;
  return { blockStreak: 0, blockedUntil: 0, recoverUntil: now.getTime() + RECOVER_MS };
}

// True when a check was due more than STALL_GRACE_MS ago and hasn't happened
// (Mac asleep, tab discarded or closed, Chrome quit).
const STALL_GRACE_MS = 15 * MS_MIN;
const NUDGE_WAIT_MS = 4 * MS_MIN;
function isStalled(nowMs, nextCheckAt) {
  return !!nextCheckAt && nowMs > nextCheckAt + STALL_GRACE_MS;
}

// What to do about one watched tab: "none", "nudge" (reload it and see if
// checks resume, which is what happens after the Mac wakes from sleep) or
// "warn" (a nudge didn't help). w = { nextCheckAt, stage, nudgedAt }.
function stallAction(nowMs, w) {
  if (!w || !isStalled(nowMs, w.nextCheckAt)) return "none";
  if (!w.stage) return "nudge";
  if (w.stage === 1 && nowMs >= (w.nudgedAt || 0) + NUDGE_WAIT_MS) return "warn";
  return "none";
}

function fmtClock(min) {
  const h = Math.floor(min / 60), m = Math.floor(min % 60);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

if (typeof module !== "undefined") {
  module.exports = { inPeak, inNight, msUntilPeakStart, baseIntervalMin, isResting, nextReload, onBlocked, onCheckOk, isStalled, stallAction, fmtClock, RECOVER_MIN_INTERVAL, STALL_GRACE_MS };
}
