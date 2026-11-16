const assert = require("node:assert");
const { buildNtfy, validNtfyTopic, randomNtfyTopic } = require("../notify.js");

assert.equal(buildNtfy({ topic: "" }), null);
assert.equal(buildNtfy({ topic: "short" }), null);
assert.equal(buildNtfy({ topic: "has space in it" }), null);
assert.ok(validNtfyTopic(randomNtfyTopic()));

const req = buildNtfy({ server: "https://ntfy.sh/", topic: "duo-abc12345", title: "T", message: "M — Queens Center", click: "https://www.apple.com/x", priority: 5, tags: ["iphone"] });
assert.equal(req.url, "https://ntfy.sh");
assert.equal(req.init.method, "POST");
assert.deepEqual(JSON.parse(req.init.body), { topic: "duo-abc12345", title: "T", message: "M — Queens Center", priority: 5, tags: ["iphone"], click: "https://www.apple.com/x" });
assert.equal("click" in JSON.parse(buildNtfy({ topic: "duo-abc12345", title: "T", message: "M" }).init.body), false);
console.log("all notify tests passed");
