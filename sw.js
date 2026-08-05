
const C = 'mtgc-v1';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = e.request.url;
  if (u.includes('scryfall.io') || u.includes('fonts.gstatic') || u.includes('fonts.googleapis')) {
    // cache-first for card images, mana symbols, fonts -> offline after first view
    e.respondWith((async () => {
      const cache = await caches.open(C);
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    })());
  } else if (e.request.mode === 'navigate') {
    // network-first for the app shell, cached fallback for offline
    e.respondWith((async () => {
      try {
        const res = await fetch(e.request);
        const cache = await caches.open(C);
        cache.put(e.request, res.clone());
        return res;
      } catch (err) {
        return (await caches.match(e.request)) || Response.error();
      }
    })());
  }
});
