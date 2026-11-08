// Offline support for Game night. Bump VERSION when precached files change.
const VERSION = "v3";
const CACHE = `game-night-${VERSION}`;
const PRECACHE = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-180.png"];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith("game-night-") && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network with a timeout, so a weak connection falls back to the cached copy quickly.
function networkFirst(req, cacheKey, ms = 3000) {
  return new Promise(resolve => {
    let done = false;
    const fallback = () => caches.match(cacheKey).then(r => { if (!done && r) { done = true; resolve(r); } });
    const timer = setTimeout(fallback, ms);
    fetch(req).then(res => {
      clearTimeout(timer);
      if (res.ok) caches.open(CACHE).then(c => c.put(cacheKey, res.clone()));
      if (!done) { done = true; resolve(res); }
    }).catch(() => {
      clearTimeout(timer);
      caches.match(cacheKey).then(r => { if (!done) { done = true; resolve(r || Response.error()); } });
    });
  });
}

function staleWhileRevalidate(req) {
  return caches.open(CACHE).then(c => c.match(req).then(hit => {
    const net = fetch(req).then(res => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (req.mode === "navigate" && url.origin === location.origin) {
    e.respondWith(networkFirst(req, "/"));
  } else if (url.origin === location.origin || FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(staleWhileRevalidate(req));
  }
});
