/*
 * Minimaler Service Worker.
 *
 * Er cached nur die App-Huelle. Zustandsdaten kommen ausschliesslich ueber den
 * WebSocket – sie zu cachen wuerde bedeuten, veraltete Spiegel-Einstellungen
 * anzuzeigen, und das ist schlimmer als eine Offline-Meldung.
 */
const CACHE = 'mirror-remote-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(['./', './index.html', './manifest.webmanifest', './icon.svg'])),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Alles Dynamische am Cache vorbei.
  if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/healthz') || url.pathname.startsWith('/modules')) {
    return;
  }
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        void caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit ?? caches.match('./index.html'))),
  );
});
