/* Todo List — offline app shell.
 *
 * Scope of responsibility:
 *   - Precache the same-origin shell so a cold start with no connection boots
 *     the app (which then renders its localStorage copy of Home / each list).
 *   - Keep the hosted third-party assets the shell needs (Tailwind, the
 *     usernode-native kit, Google Fonts) warm WITHOUT vendoring them: they are
 *     cached opportunistically and revalidated on every online load, so kit
 *     fixes still propagate on the next page load exactly as the platform
 *     conventions require.
 *   - Never touch /api/* — API responses and the SSE stream must always go to
 *     the network, and the app's own read cache handles offline data.
 *
 * Bump CACHE_VERSION whenever the shell changes; activate drops every other
 * cache, so there is no stale-asset tail to reason about.
 */
// v4: the shell's Tailwind tag moved to the platform origin. The bump is what
// makes that reach people who already have the app installed — activate drops
// the v3 caches, so no returning user keeps a shell pointing at the old CDN,
// and the stale cdn.tailwindcss.com asset entry goes with them.
const CACHE_VERSION = 'todo-v4';
const SHELL_CACHE = CACHE_VERSION + '-shell';
const ASSET_CACHE = CACHE_VERSION + '-assets';

// The shell HTML. `/index.html` is served straight off express.static — the
// auth gate only covers non-GET and /api/*, so the service worker can precache
// it with no token. The catch-all ("/") is deliberately NOT precached: for a
// logged-out visitor that response is the public landing page, and caching it
// would poison the shell entry.
const SHELL_URL = '/index.html';
const PRECACHE = [SHELL_URL, '/theme.css', '/favicon.svg'];

// The ONLY same-origin paths this worker is allowed to serve from cache. It
// used to be "everything that isn't /api/*", which quietly enrolled every path
// the app might grow later — including platform-polled ones like
// /explorer-api/*, which is unauthenticated by convention and must never be
// answered from a stale cache. An allowlist can't acquire new members by
// accident; anything not named here goes straight to the network.
const CACHEABLE_PATHS = new Set([SHELL_URL, '/theme.css', '/favicon.svg', '/landing.html']);

// Cross-origin hosts whose assets are worth keeping for an offline load. Kept
// deliberately tight: opaque cross-origin entries are padded heavily against
// the storage quota.
const ASSET_HOSTS = [
  // Tailwind now comes from the platform origin below, which is already
  // listed — so the offline copy of it is still cached, under that host.
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'social-vibecoding.usernodelabs.org',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Individually, not addAll: one unavailable file must not fail the whole
    // install and leave the app with no service worker at all.
    await Promise.all(PRECACHE.map(async url => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res && res.ok) await cache.put(url, res.clone());
      } catch (_) { /* stays uncached; the fetch handler fills it later */ }
    }));
    await self.skipWaiting();
  })());
});

// Re-pull the shell so a redeployed index.html replaces the cached copy.
async function refreshShell() {
  try {
    const res = await fetch(SHELL_URL, { cache: 'reload' });
    if (res && res.ok) await (await caches.open(SHELL_CACHE)).put(SHELL_URL, res.clone());
  } catch (_) { /* offline — the existing copy stays */ }
}

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter(n => n !== SHELL_CACHE && n !== ASSET_CACHE).map(n => caches.delete(n))
    );
    await self.clients.claim();
    await refreshShell();
  })());
});

// The shell is deployed independently of this file, so a deploy that only
// changes index.html would otherwise leave a stale offline fallback behind.
// The page pings us on every online boot; that keeps the fallback current.
self.addEventListener('message', event => {
  if (event.data === 'refresh-shell') event.waitUntil(refreshShell());
});

// Refresh an entry in the background; failures are expected offline.
function revalidate(cacheName, request, response) {
  if (!response) return;
  if (!(response.ok || response.type === 'opaque')) return;
  caches.open(cacheName)
    .then(cache => cache.put(request, response))
    .catch(() => {});
}

// Serve from cache immediately when we have it, and refresh it from the network
// in the background (stale-while-revalidate).
async function staleWhileRevalidate(cacheName, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(res => { revalidate(cacheName, request, res.clone()); return res; })
    .catch(err => { if (cached) return null; throw err; });
  if (cached) return cached;
  const res = await network;
  if (res) return res;
  throw new Error('unavailable');
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  const sameOrigin = url.origin === self.location.origin;

  // The API and the SSE stream are always network-only. Buffering an
  // event-stream through the worker would break live updates outright.
  if (sameOrigin && (url.pathname.startsWith('/api/') || url.pathname === '/health')) return;
  if (req.headers.get('accept') === 'text/event-stream') return;

  // Navigations: network-first so an online logged-out visitor still gets the
  // landing page, with the precached shell as the offline fallback. The
  // navigation response is never written to the cache.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch (_) {
        const cached = await caches.match(SHELL_URL, { cacheName: SHELL_CACHE });
        if (cached) return cached;
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
          '<body style="font:16px system-ui;padding:2rem;text-align:center">' +
          "<p>You're offline and this app hasn't been saved for offline use yet.</p>",
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  if (sameOrigin) {
    // Explicit allowlist — see CACHEABLE_PATHS. /sw.js is deliberately absent
    // (a worker that caches itself can never be replaced).
    if (!CACHEABLE_PATHS.has(url.pathname)) return;
    event.respondWith(staleWhileRevalidate(SHELL_CACHE, req).catch(() => fetch(req)));
    return;
  }

  if (ASSET_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(ASSET_CACHE, req).catch(() => fetch(req)));
  }
});
