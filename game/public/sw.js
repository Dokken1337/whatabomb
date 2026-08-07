// Bumped per release so the activate handler drops the previous cache.
//
// Keep this in step with package.json. It was left on 1.18.0 through the 1.19.0
// release, which now matters more than it used to: the client checks the wire
// protocol version on connect and refuses to play a mismatch, so a stale shell
// served from this cache is the difference between playing and being told to
// reload.
const CACHE_NAME = 'whatabomb-v1-20-0'
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  // Network-first strategy: try network, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful GET responses
        if (event.request.method === 'GET' && response.status === 200) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
        }
        return response
      })
      .catch(() => caches.match(event.request))
  )
})
