// Minimal app-shell service worker for Wendler 5/3/1 PWA.
// Bump CACHE on each meaningful change to evict stale assets.
// Strategy: network-first for HTML navigations (so deploys land immediately),
// stale-while-revalidate for everything else.
const CACHE = 'wendler-shell-v383';
const SHELL = ['/', '/program', '/movements', '/history', '/settings', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API responses — they're authenticated, user-specific, and
  // mutate (e.g. /api/strava/status changes after Sync now). Letting the
  // SW serve a stale-while-revalidate copy here means the UI keeps
  // showing yesterday's lastSyncAt until a hard refresh.
  if (url.pathname.startsWith('/api/')) return;

  const isNav = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  if (isNav) {
    // Network-first for page navigations so a fresh deploy is picked up immediately.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match('/'))),
    );
    return;
  }

  // Stale-while-revalidate for static assets.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    }),
  );
});
