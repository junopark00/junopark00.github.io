/* 점메추 service worker
   - App shell (index, manifest, icons): network-first with cache fallback, so updates land immediately when online
     and the app still opens offline.
   - Kakao / CDN requests are never cached (map tiles, search API, fonts are left to the browser). */
const VERSION = "jmc-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icons/icon.svg", "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;   // only our own files
  e.respondWith(
    fetch(e.request)
      .then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then(hit => hit || (e.request.mode === "navigate" ? caches.match("./index.html") : undefined)))
  );
});
