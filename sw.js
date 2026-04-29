const CACHE_NAME = 'cambuur-app-v3';
const STATIC_ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json',
];

// Installatie: cache statische bestanden
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
    );
    self.skipWaiting();
});

// Activatie: verwijder oude caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

// Fetch: cache-first voor statische bestanden van eigen origin
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Externe requests niet onderscheppen; laat de browser dit direct afhandelen.
    if (url.origin !== self.location.origin) {
        return;
    }

    // Statische bestanden: cache-first
    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;
            return fetch(event.request)
                .then((response) => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    return response;
                })
                .catch(() => new Response('Offline', {
                    status: 503,
                    statusText: 'Service Unavailable',
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                }));
        })
    );
});
