const assert = require("node:assert");
const { addHistory, summarizeHistory, historyToCsv, splitIgnored, knownStores, hitsByHour, locationLabel, HISTORY_MAX } = require("../history.js");
let h = [];
for (let i = 0; i < HISTORY_MAX + 10; i++) h = addHistory(h, { t: i, result: "none" });
assert.equal(h.length, HISTORY_MAX); assert.equal(h[0].t, 10);
const now = Date.now(), yesterday = now - 86_400_000 * 2;
const list = [
  { t: yesterday, result: "available", model: "256GB Night Sky", stores: ["SoHo"] },
  { t: now, result: "none" }, { t: now, result: "blocked" }, { t: now, result: "nodata" },
];
const s = summarizeHistory(list);
assert.deepEqual([s.checks, s.available, s.blocked, s.nodata], [3, 0, 1, 1]);
assert.equal(s.lastAvailable.stores[0], "SoHo"); // remembered even though it was before today
const csv = historyToCsv([{ t: 0, model: 'A "b"', result: "available", stores: ["X", "Y"], zip: "10001" }]);
assert.equal(csv.split("\n")[1], '"1970-01-01T00:00:00.000Z","A ""b""","available","X; Y","10001",""');
assert.equal(historyToCsv([]).split("\n")[0], "time,model,result,stores,location,note");

// store filter
const avail = [{ store: "Downtown Brooklyn" }, { store: "American Dream" }];
assert.deepEqual(splitIgnored(avail, ["American Dream"]).alert.map((a) => a.store), ["Downtown Brooklyn"]);
assert.deepEqual(splitIgnored(avail, ["American Dream"]).ignored.map((a) => a.store), ["American Dream"]);
assert.equal(splitIgnored(avail, undefined).alert.length, 2);
assert.deepEqual(knownStores([{ stores: ["West 14th Street"] }, { stores: ["Queens Center", "West 14th Street"] }, {}]),
  ["Queens Center", "West 14th Street"]);

// hits by hour (local time)
const hours = hitsByHour([
  { t: new Date(2026, 10, 13, 9, 47).getTime(), result: "available" },
  { t: new Date(2026, 10, 13, 9, 59).getTime(), result: "available" },
  { t: new Date(2026, 10, 14, 0, 4).getTime(), result: "available" },
  { t: new Date(2026, 10, 14, 9, 0).getTime(), result: "none" },
]);
assert.equal(hours.length, 24); assert.equal(hours[9], 2); assert.equal(hours[0], 1); assert.equal(hours.reduce((a, b) => a + b), 3);

// location label: ZIP vs store name
assert.equal(locationLabel("10001"), "ZIP 10001");
assert.equal(locationLabel("Apple West 14th Street", ["West 14th Street"]), "");
assert.equal(locationLabel("Apple West 14th Street", ["SoHo"]), "near West 14th Street");
assert.equal(locationLabel(""), "");
// the same restock seen on back-to-back checks counts once; ignored stores don't count
const at = (d, h, m) => new Date(2026, 10, d, h, m).getTime();
const restock = hitsByHour([
  { t: at(13, 9, 47), result: "available", stores: ["Downtown Brooklyn"] },
  { t: at(13, 9, 48), result: "available", stores: ["Downtown Brooklyn"] },
  { t: at(13, 9, 55), result: "available", stores: ["Downtown Brooklyn"] },
  { t: at(13, 10, 18), result: "available", stores: ["Downtown Brooklyn"] }, // 23 min after the last: new
  { t: at(13, 10, 48), result: "available", stores: ["American Dream"] },
  { t: at(13, 10, 50), result: "available", stores: ["Queens Center", "Downtown Brooklyn"] }, // Queens Center is new
], ["American Dream"]);
assert.equal(restock[9], 1);
assert.equal(restock[10], 2);
console.log("all history tests passed");
