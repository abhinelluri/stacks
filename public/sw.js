/* Offline support: the app shell and cover art are cached; your library lives in IndexedDB (see app.js). */
const SHELL = "stacks-shell-v2", ART = "stacks-art-v1";
const FILES = ["/", "/styles.css", "/app.js", "/vendor/simplewebauthn-browser.js", "/vendor/qrcode.js", "/manifest.webmanifest", "/favicon.png", "/icons/icon-192.png"];

self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => ![SHELL, ART].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return;                       // the app handles offline API itself

  if (url.pathname.startsWith("/img/")) {                              // cover art: cache first
    e.respondWith(caches.open(ART).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    }));
    return;
  }
  if (e.request.mode === "navigate") {                                 // pages: network first, cached shell offline
    e.respondWith(fetch(e.request, { cache: "no-cache" }).then(r => { const copy = r.clone(); if (r.ok) caches.open(SHELL).then(c => c.put("/", copy)); return r; }).catch(() => caches.match("/")));
    return;
  }
  e.respondWith(caches.open(SHELL).then(c =>                          // app files: newest version when online, cached copy offline
    fetch(e.request, { cache: "no-cache" }).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => c.match(e.request))
  ));
});
