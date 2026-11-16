// Turns a fulfillment-messages JSON response into a short summary.
// The response shape is not documented by Apple, so this walks the JSON
// defensively instead of trusting one exact path.
const AVAILABLE_RE = /\bavailable\b|\btoday\b|\btomorrow\b|in stock/i;
const UNAVAILABLE_RE = /unavailable|not available|currently unavailable|sold out|ineligible/i;

function isAvailable(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.pickupDisplay) return entry.pickupDisplay === "available";
  const quote = [entry.pickupSearchQuote, entry.storePickupQuote, entry.messageTypes?.regular?.storePickupQuote]
    .filter(Boolean).join(" ");
  return !!quote && AVAILABLE_RE.test(quote) && !UNAVAILABLE_RE.test(quote);
}

function quoteOf(entry) {
  const q = entry?.pickupSearchQuote || entry?.messageTypes?.regular?.storePickupQuote || entry?.storePickupQuote || "";
  return String(q).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parseFulfillment(json) {
  const content = json?.body?.content ?? json?.body ?? json ?? {};
  const stores = content?.pickupMessage?.stores ?? [];
  const pm = content?.pickupMessage ?? {};
  const result = {
    storesChecked: 0, available: [], delivery: null,
    stores: [], // every store in the results: { store, city, available, quote }
    location: pm.location || pm.pickupLocation || null,
  };

  for (const store of stores) {
    const parts = store?.partsAvailability ?? {};
    const name = store?.storeName || store?.storeNumber || "Unknown store";
    for (const [part, entry] of Object.entries(parts)) {
      result.storesChecked++;
      const ok = isAvailable(entry);
      result.stores.push({ part, store: name, city: store.city || "", available: ok, quote: quoteOf(entry) });
      if (ok) result.available.push({ part, store: name, city: store.city || "", quote: quoteOf(entry) });
    }
  }

  // Delivery estimate, if present (informational only).
  const dm = content?.deliveryMessage;
  if (dm && typeof dm === "object") {
    for (const v of Object.values(dm)) {
      const msg = v?.regular?.deliveryOptionMessages?.[0]?.displayName || v?.regular?.deliveryOptions?.[0]?.date;
      if (msg) { result.delivery = String(msg).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); break; }
    }
  }
  return result;
}

if (typeof module !== "undefined") module.exports = { parseFulfillment };
