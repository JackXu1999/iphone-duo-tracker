// Builds a phone push through ntfy (https://ntfy.sh): install the ntfy app,
// subscribe to a topic name, and enter the same name in the watcher box.
// Anyone who knows the topic name can read it, so use a long random one.

const NTFY_TOPIC_RE = /^[-_A-Za-z0-9]{8,64}$/;

function validNtfyTopic(topic) {
  return NTFY_TOPIC_RE.test(String(topic || ""));
}

// Returns { url, init } for fetch(), or null when no valid topic is set.
// Uses ntfy's JSON publishing so titles and store names need no header encoding.
function buildNtfy({ server = "https://ntfy.sh", topic, title, message, click, priority = 3, tags = [] }) {
  if (!validNtfyTopic(topic)) return null;
  const body = { topic, title, message, priority, tags };
  if (click) body.click = click;
  return {
    url: String(server).replace(/\/+$/, ""),
    init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  };
}

// A random topic name to suggest, e.g. "duo-k3v9q2m7x1p8".
function randomNtfyTopic(rand = Math.random) {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "duo-";
  for (let i = 0; i < 16; i++) s += abc[Math.floor(rand() * abc.length)];
  return s;
}

if (typeof module !== "undefined") module.exports = { buildNtfy, validNtfyTopic, randomNtfyTopic };
