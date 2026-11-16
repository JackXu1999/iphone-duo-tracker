// iPhone Duo configurations and the product-page URLs for them.
// Watching several models works by moving the tab to the next model's page
// on each scheduled check, so the extension still only reads what Apple's
// own page loads.

const DUO_MODELS = [
  { slug: "256gb-night-sky", label: "256GB Night Sky", part: "MK1F4LL/A" },
  { slug: "256gb-star-white", label: "256GB Star White", part: "MK1E4LL/A" },
  { slug: "512gb-night-sky", label: "512GB Night Sky", part: "MK1H4LL/A" },
  { slug: "512gb-star-white", label: "512GB Star White", part: "MK1G4LL/A" },
  { slug: "1tb-night-sky", label: "1TB Night Sky", part: "MK1L4LL/A" },
  { slug: "1tb-star-white", label: "1TB Star White", part: "MK1J4LL/A" },
  { slug: "2tb-night-sky", label: "2TB Night Sky", part: "MK1R4LL/A" },
  { slug: "2tb-star-white", label: "2TB Star White", part: "MK1Q4LL/A" },
];

const PAGE_RE = /\/shop\/buy-iphone\/iphone-duo\/7\.6-inch-display-(\d+(?:gb|tb)-(?:night-sky|star-white))-([a-z-]+)\/?$/;

// "https://…/7.6-inch-display-256gb-night-sky-unlocked" -> { slug, carrier }
function parseModelPage(href) {
  let path;
  try { path = new URL(href).pathname; } catch { return null; }
  const m = path.match(PAGE_RE);
  return m ? { slug: m[1], carrier: m[2] } : null;
}

function modelPageUrl(origin, slug, carrier) {
  return `${origin}/shop/buy-iphone/iphone-duo/7.6-inch-display-${slug}-${carrier}`;
}

function modelLabel(slug) {
  return DUO_MODELS.find((m) => m.slug === slug)?.label || slug;
}

function modelForPart(part) {
  return DUO_MODELS.find((m) => m.part === part) || null;
}

// The slug to load next. Keeps model order stable; if the current page isn't
// in the list, starts from the first watched model.
function nextModelSlug(currentSlug, watchList) {
  const ordered = DUO_MODELS.map((m) => m.slug).filter((s) => watchList.includes(s));
  if (ordered.length === 0) return currentSlug;
  const i = ordered.indexOf(currentSlug);
  return ordered[(i + 1) % ordered.length];
}

if (typeof module !== "undefined") {
  module.exports = { DUO_MODELS, parseModelPage, modelPageUrl, modelLabel, modelForPart, nextModelSlug };
}
