// Runs in the page's own context. It only *observes* the responses the Apple
// page already receives for its fulfillment (pickup/delivery) requests and
// forwards a copy to watcher.js. It never makes requests of its own.
(() => {
  const MATCH = "/shop/fulfillment-messages";
  const post = (url, status, body) =>
    window.postMessage({ __duoWatcher: true, url, status, body }, location.origin);

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (url.includes(MATCH)) {
        res.clone().text().then((t) => post(url, res.status, t)).catch(() => {});
      }
    } catch (_) {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (String(url).includes(MATCH)) {
      this.addEventListener("loadend", () => {
        try { post(String(url), this.status, this.responseText); } catch (_) {}
      });
    }
    return origOpen.call(this, method, url, ...rest);
  };
})();
