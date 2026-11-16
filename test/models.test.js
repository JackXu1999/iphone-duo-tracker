const assert = require("node:assert");
const { DUO_MODELS, parseModelPage, modelPageUrl, modelLabel, modelForPart, nextModelSlug } = require("../models.js");
const base = "https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-";
assert.deepEqual(parseModelPage(base + "256gb-night-sky-unlocked"), { slug: "256gb-night-sky", carrier: "unlocked" });
assert.deepEqual(parseModelPage(base + "1tb-star-white-t-mobile"), { slug: "1tb-star-white", carrier: "t-mobile" });
assert.deepEqual(parseModelPage(base + "2tb-night-sky-verizon/"), { slug: "2tb-night-sky", carrier: "verizon" });
assert.equal(parseModelPage("https://www.apple.com/shop/buy-iphone/iphone-duo"), null);
assert.equal(parseModelPage("not a url"), null);
assert.equal(modelPageUrl("https://www.apple.com", "512gb-star-white", "att"), base + "512gb-star-white-att");
assert.equal(modelLabel("512gb-night-sky"), "512GB Night Sky");
assert.equal(modelForPart("MK1F4LL/A").slug, "256gb-night-sky");
assert.equal(DUO_MODELS.length, 8);
// rotation follows catalog order and wraps
const list = ["512gb-night-sky", "256gb-night-sky", "256gb-star-white"];
assert.equal(nextModelSlug("256gb-night-sky", list), "256gb-star-white");
assert.equal(nextModelSlug("256gb-star-white", list), "512gb-night-sky");
assert.equal(nextModelSlug("512gb-night-sky", list), "256gb-night-sky");
assert.equal(nextModelSlug("2tb-night-sky", list), "256gb-night-sky"); // current page not watched
assert.equal(nextModelSlug("256gb-night-sky", []), "256gb-night-sky");
console.log("all model tests passed");
