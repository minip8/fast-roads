// Service worker, so the game works offline once loaded. Production builds only: vite.config.ts fills in VERSION and
// FILES and writes it to dist/sw.js; boot.ts registers it. Plain JS because it runs in a worker, not the page.
//
// - index.html is network-first: every online load gets the current deploy, and the precached copy is used only when
//   the network fails, so a stale page can't stick. Navigations don't update the cache: the offline copy always
//   matches the precached build files.
// - Everything else is a content-hashed build file (or a small public file), served from the precache, else network.
// - The car models (LAZY, a few MB each, versioned by ?v=<content hash>) are not precached: each is kept in its own
//   cache the first time the game fetches it, and kept across deploys while the deploy still uses that version.
// - The trained policies (ai/, fetched only with ?autopilot=rl) are neither: precache misses, so the network serves them.
//   The same goes for the autopilot's ghost laps (ghosts/, fetched only with the Ghost car setting on Autopilot).
// - A new deploy changes this file, so the browser installs the new version on the next load; it activates at once
//   and deletes the previous cache. Caches are per scope, so copies at different sub-paths don't touch each other.
// - To retire it, deploy a sw.js that calls self.registration.unregister().
const VERSION = __VERSION__;
const FILES = __FILES__;   // relative to this script; './' is index.html
const LAZY = new Set(__LAZY__.map((f) => new URL(f, self.registration.scope).href));
const PREFIX = 'fastroads ' + self.registration.scope + ' ';
const CACHE = PREFIX + VERSION;
const MODELS = PREFIX + 'models';
const INDEX = new URL('./', self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // index.html revalidated so it matches this build; hashed files can come from the HTTP cache
    await cache.addAll(FILES.map((f) => (f === './' ? new Request(f, { cache: 'no-cache' }) : f)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE && key !== MODELS) await caches.delete(key);
    const models = await caches.open(MODELS);   // models this deploy no longer uses
    for (const req of await models.keys()) if (!LAZY.has(req.url)) await models.delete(req);
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.registration.scope)) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(async (err) => (await caches.match(INDEX, { cacheName: CACHE })) ?? Promise.reject(err)));
    return;
  }
  if (LAZY.has(req.url)) {
    event.respondWith((async () => {
      const cache = await caches.open(MODELS).catch(() => null);
      const hit = await cache?.match(req).catch(() => undefined);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && cache) event.waitUntil(cache.put(req, res.clone()).catch(() => {}));
      return res;
    })());
    return;
  }
  event.respondWith((async () => {
    try {
      const hit = await caches.match(req, { cacheName: CACHE });
      if (hit) return hit;
    } catch { /* cache unavailable: use the network */ }
    return fetch(req);
  })());
});
