const CACHE_NAME = 'shivadraw-cache-v13';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests over HTTP/HTTPS
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  const url = new URL(event.request.url);

  // Network-first for the HTML entry point: fetch fresh when online, but CACHE it so we can fall back to it when offline
  if (url.pathname.endsWith('/') || url.pathname.endsWith('.html') || url.pathname === '/sd' || url.pathname === '/sd/') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          return caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) return cachedResponse;
            // Fallback: If they requested index.html offline but we only cached root scope, or vice-versa
            return caches.match(self.registration.scope)
              .then((fallback) => {
                if (fallback) return fallback;
                const indexUrl = new URL('index.html', self.registration.scope).toString();
                return caches.match(indexUrl);
              });
          });
        })
    );
    return;
  }

  // For all other assets (JS, CSS, fonts, images): network-first, fallback to cache
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache valid responses for static assets
        if (response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Fallback to cache if network fails (offline mode)
        return caches.match(event.request);
      })
  );
});
