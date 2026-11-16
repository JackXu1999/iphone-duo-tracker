const assert = require("node:assert");
const { parseFulfillment } = require("../parse.js");
const P = "MK1F4LL/A";
const wrap = (stores, extra = {}) => ({ head: { status: "200" }, body: { content: { pickupMessage: { stores }, ...extra } } });
const st = (name, entry) => ({ storeName: name, city: "New York", partsAvailability: { [P]: entry } });

// 1. pickupDisplay flag wins
let r = parseFulfillment(wrap([st("Fifth Avenue", { pickupDisplay: "available", pickupSearchQuote: "Available<br/>Today" }),
                              st("SoHo", { pickupDisplay: "unavailable", pickupSearchQuote: "Currently unavailable" })]));
assert.equal(r.storesChecked, 2); assert.equal(r.available.length, 1);
assert.equal(r.available[0].store, "Fifth Avenue"); assert.equal(r.available[0].quote, "Available Today");

// 2. quote-only fallback
r = parseFulfillment(wrap([st("A", { pickupSearchQuote: "Available Tomorrow" }), st("B", { pickupSearchQuote: "Not available today" }),
                          st("C", { messageTypes: { regular: { storePickupQuote: "Currently unavailable" } } })]));
assert.deepEqual(r.available.map((a) => a.store), ["A"]);

// 3. nothing / empty / garbage
assert.equal(parseFulfillment(wrap([])).storesChecked, 0);
assert.equal(parseFulfillment({}).available.length, 0);
assert.equal(parseFulfillment(null).available.length, 0);

// 4. delivery message
r = parseFulfillment(wrap([], { deliveryMessage: { [P]: { regular: { deliveryOptionMessages: [{ displayName: "Delivers <b>Nov 20</b>" }] } } } }));
assert.equal(r.delivery, "Delivers Nov 20");
console.log("all parser tests passed");

// store list + location
r = parseFulfillment(wrap([st("Grand Central", { pickupDisplay: "unavailable" }), st("World Trade Center", { pickupDisplay: "available" })]));
assert.deepEqual(r.stores.map((s) => [s.store, s.available]), [["Grand Central", false], ["World Trade Center", true]]);
assert.equal(parseFulfillment({ body: { content: { pickupMessage: { location: "10001", stores: [] } } } }).location, "10001");
console.log("store list tests passed");
