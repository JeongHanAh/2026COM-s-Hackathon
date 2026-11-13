const CACHE = 'our-days-shell-v14';
const SHELL = [
  '/', '/styles.css', '/app.js', '/device.js', '/record-sync.js', '/icons.js', '/home.js', '/home.css', '/icon.svg', '/manifest.webmanifest',
  '/unosat-al-shati-2025-07-08.webp', '/unosat-al-shati-2025-10-11.webp'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('our-days-shell-') && key !== CACHE).map(key => caches.delete(key))))
  ]));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode !== 'navigate' && !SHELL.includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = request.mode === 'navigate' ? '/' : url.pathname;
    try {
      const response = await fetch(request, { signal: AbortSignal.timeout(6500) });
      if (response.ok) await cache.put(key, response.clone());
      return response;
    } catch {
      return await cache.match(key) || Response.error();
    }
  })());
});
