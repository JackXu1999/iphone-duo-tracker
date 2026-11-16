const assert = require("node:assert");
const { inPeak, inNight, nextReload, baseIntervalMin, onBlocked, onCheckOk, isStalled, stallAction, STALL_GRACE_MS, fmtClock } = require("../schedule.js");
const S = { intervalMin: 10, peakEnabled: true, peakStartMin: 8 * 60 + 45, peakEndMin: 10 * 60 + 30, peakIntervalMin: 1,
  nightStartMin: 22 * 60, nightMinIntervalMin: 10, blockStreak: 0, blockedUntil: 0, recoverUntil: 0 };
const at = (h, m, s = 0) => new Date(2026, 10, 12, h, m, s);
const mid = () => 0.5; // no jitter, no extra wait
const MIN = 60_000;

// window edges
assert.equal(inPeak(at(8, 44, 59), S), false);
assert.equal(inPeak(at(8, 45), S), true);
assert.equal(inPeak(at(10, 29, 59), S), true);
assert.equal(inPeak(at(10, 30), S), false);
assert.equal(inPeak(at(9, 0), { ...S, peakEnabled: false }), false);

// in peak -> 1 minute
assert.deepEqual(nextReload(at(9, 15), S, mid), { delayMs: 1 * MIN, peak: true, resting: false });
// off peak, far from window -> normal 10 minutes
assert.deepEqual(nextReload(at(14, 0), S, mid), { delayMs: 10 * MIN, peak: false, resting: false });
// off peak, 4 min before start -> wake at 8:45, not 10 min later
assert.equal(nextReload(at(8, 41), S, () => 0).delayMs, 4 * MIN);
// late night -> wake at 8:45 next morning only if it's sooner than interval (it isn't)
assert.equal(nextReload(at(23, 58), S, mid).delayMs, 10 * MIN);
// peak disabled -> normal interval even during 9 AM
assert.equal(nextReload(at(9, 0), { ...S, peakEnabled: false }, mid).delayMs, 10 * MIN);

// night: 10 PM until the peak, checks at least 10 min apart
const fast = { ...S, intervalMin: 2 };
assert.equal(inNight(at(21, 59), S), false);
assert.equal(inNight(at(22, 0), S), true);
assert.equal(inNight(at(1, 0), S), true);
assert.equal(inNight(at(8, 45), S), false);
assert.equal(baseIntervalMin(at(21, 0), fast), 2);
assert.equal(baseIntervalMin(at(1, 0), fast), 10);
assert.equal(baseIntervalMin(at(9, 0), fast), 1); // peak is not slowed
assert.equal(baseIntervalMin(at(14, 0), { ...fast, intervalMin: 15 }), 15);
// near the peak, night pacing still wakes at 8:45
assert.equal(nextReload(at(8, 40), fast, () => 0).delayMs, 5 * MIN);

// block at 1 AM (as in the Nov 13-15 log): rest until 8:45 AM
const b1 = onBlocked(at(1, 0), fast);
assert.equal(b1.blockStreak, 1);
assert.equal(b1.blockedUntil, at(8, 45).getTime());
const r1 = nextReload(at(1, 0), { ...fast, ...b1 }, () => 0);
assert.deepEqual(r1, { delayMs: (7 * 60 + 45) * MIN, peak: false, resting: true });
// resting beats peak timing
assert.equal(nextReload(at(8, 44), { ...fast, ...b1 }, () => 0).delayMs, 1 * MIN);
// block during peak: 1 h, then 2 h, then 4 h, then 8 h max (when not waiting for a peak)
assert.equal(onBlocked(at(9, 0), fast).blockedUntil, at(10, 0).getTime());
assert.equal(onBlocked(at(9, 0), { ...fast, blockStreak: 1 }).blockedUntil, at(11, 0).getTime());
const off = { ...fast, peakEnabled: false };
assert.equal(onBlocked(at(12, 0), { ...off, blockStreak: 2 }).blockedUntil, at(16, 0).getTime());
assert.equal(onBlocked(at(12, 0), { ...off, blockStreak: 9 }).blockedUntil, at(20, 0).getTime());
// block in the afternoon with peak on: rest until tomorrow's peak
assert.equal(onBlocked(at(15, 0), fast).blockedUntil, new Date(2026, 10, 13, 8, 45).getTime());

// first good check after a block: clear it, then 3+ min apart for an hour
assert.equal(onCheckOk(at(9, 0), fast), null);
const ok = onCheckOk(at(8, 50), { ...fast, ...b1 });
assert.deepEqual(ok, { blockStreak: 0, blockedUntil: 0, recoverUntil: at(9, 50).getTime() });
const rec = { ...fast, ...ok };
assert.equal(baseIntervalMin(at(9, 0), rec), 3);
assert.equal(baseIntervalMin(at(9, 50), rec), 1);
assert.equal(nextReload(at(9, 0), rec, mid).resting, false);
// jitter stays within ±15%
for (let i = 0; i < 1000; i++) { const d = nextReload(at(14, 0), S).delayMs; assert.ok(d >= 8.5 * MIN && d <= 11.5 * MIN); }
for (let i = 0; i < 1000; i++) { const d = nextReload(at(9, 0), S).delayMs; assert.ok(d >= 51_000 && d <= 69_000); }

// stall: a check due 15+ min ago that hasn't happened
assert.equal(isStalled(1000, null), false);
assert.equal(isStalled(1000 + STALL_GRACE_MS, 1000), false);
assert.equal(isStalled(1001 + STALL_GRACE_MS, 1000), true);
// stall: reload once first (Mac waking from sleep), warn only if that didn't help
const late = 1001 + STALL_GRACE_MS;
assert.equal(stallAction(late, null), "none");
assert.equal(stallAction(late, { nextCheckAt: 1000, stage: 0 }), "nudge");
assert.equal(stallAction(late, { nextCheckAt: 1000, stage: 1, nudgedAt: late }), "none");
assert.equal(stallAction(late + 4 * MIN, { nextCheckAt: 1000, stage: 1, nudgedAt: late }), "warn");
assert.equal(stallAction(late + 60 * MIN, { nextCheckAt: 1000, stage: 2, nudgedAt: late }), "none");
assert.equal(stallAction(1000, { nextCheckAt: 1000, stage: 0 }), "none");

assert.equal(fmtClock(525), "8:45 AM"); assert.equal(fmtClock(630), "10:30 AM"); assert.equal(fmtClock(0), "12:00 AM"); assert.equal(fmtClock(780), "1:00 PM");
console.log("all schedule tests passed");
