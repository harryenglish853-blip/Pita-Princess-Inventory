/* Stockline service worker: offline app shell for counting + background sync trigger.
   Data is never cached here; count entries live in IndexedDB and sync through the app. */
const VERSION = "v1";
const SHELL = `shell-${VERSION}`;
const STATIC = `static-${VERSION}`;
const PAGES = `pages-${VERSION}`;
const PRECACHE = ["/offline", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, STATIC, PAGES].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isCountPage = (url) => /^\/counts(\/[0-9a-f-]{36})?\/?$/.test(url.pathname);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Immutable build assets: cache first.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(STATIC).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
    return;
  }

  // Page navigations: network first; count pages are kept for offline use.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && isCountPage(url) && !res.redirected) { const copy = res.clone(); caches.open(PAGES).then((c) => c.put(url.pathname, copy)); }
          return res;
        })
        .catch(async () => (await caches.match(url.pathname, { cacheName: PAGES })) || (await caches.match("/offline")) || Response.error()),
    );
  }
});

// "Download for offline": the page asks us to cache specific URLs (HTML + the scripts they use).
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "cache-urls" && Array.isArray(data.urls)) {
    event.waitUntil((async () => {
      const cache = await caches.open(PAGES);
      for (const u of data.urls) {
        try {
          const res = await fetch(u, { credentials: "include" });
          if (!res.ok || res.redirected) continue;
          await cache.put(u, res.clone());
          const html = await res.text();
          const assets = Array.from(html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)).map((m) => m[1]);
          const staticCache = await caches.open(STATIC);
          await Promise.all(assets.map((a) => staticCache.match(a).then((hit) => hit || staticCache.add(a).catch(() => undefined))));
        } catch { /* offline: skip */ }
      }
    })());
  }
  if (data.type === "clear-pages") event.waitUntil(caches.delete(PAGES));
});

// Background sync: wake an open app window to flush its IndexedDB queue.
self.addEventListener("sync", (event) => {
  if (event.tag === "count-sync") {
    event.waitUntil(self.clients.matchAll({ type: "window" }).then((cs) => cs.forEach((c) => c.postMessage({ type: "flush-counts" }))));
  }
});
