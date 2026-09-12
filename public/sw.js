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
// v7: the platform's hosted assets moved from an absolute platform hostname to
// this app's own origin. The bump is what makes that reach people who already
// have the app installed: every v6 cache holds entries keyed by the old
// hostname, which no longer answers, and activate drops them — so no returning
// user keeps trying to boot the shell from a dead host.
const CACHE_VERSION = 'todo-v7';
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

// The platform's hosted files. They are reached by RELATIVE path — the platform
// serves /usernode-bridge/, /usernode-native/ and /usernode-tailwind/ from this
// app's own hostname — so they are same-origin requests now and have to be
// named in an allowlist like any other. Naming them by PREFIX rather than
// adding four entries to CACHEABLE_PATHS keeps the two ideas apart: that set is
// this app's own files, and a /v2/ of any kit would otherwise silently stop
// being cached.
const HOSTED_PREFIXES = ['/usernode-bridge/', '/usernode-native/', '/usernode-tailwind/'];
const isHostedAsset = (pathname) => HOSTED_PREFIXES.some(p => pathname.startsWith(p));

// Cross-origin hosts whose assets are worth keeping for an offline load. Kept
// deliberately tight: opaque cross-origin entries are padded heavily against
// the storage quota.
const ASSET_HOSTS = [
  // Only the fonts are cross-origin now. The platform's own files used to be
  // listed here under its hostname; they come from this origin instead, and are
  // handled by HOSTED_PREFIXES above. Naming a platform hostname here is what
  // broke the app when that hostname moved.
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

// The hosted files the shell CANNOT render without: the kit's stylesheet
// carries every surface, Tailwind carries the layout, and /theme.css layers
// this app's palette on top. They were cached opportunistically — only ever
// as a side effect of an online load having already requested them — so the
// first offline load after an install, a cache prune or a version bump could
// come up without them. A page that paints with no stylesheet is not
// "degraded", it is unreadable (and with no --bg it is white, whatever the
// theme says), so these are fetched up front like the rest of the shell.
//
// This is caching, NOT vendoring: nothing is copied into the repo, every one of
// these paths is served by the platform rather than by this app, and
// staleWhileRevalidate still refreshes each of them on every online load — so a
// fleet-wide kit fix still lands on the very next load, exactly as the platform
// conventions require.
const HOSTED_ASSETS = [
  '/usernode-native/v1/native.css',
  '/usernode-native/v1/native.js',
  '/usernode-tailwind/v1/tailwind.js',
  '/usernode-bridge/v1/bridge.js',
];

// A hard deadline on the hosted fetches. These share this app's hostname but not
// its backend — the platform serves them — so they can still be slow or missing
// on their own. Without a deadline, installing then holds the install event open
// for as long as the network wants, and until install resolves there is no
// active worker, so a reload in that window gets no offline shell at all. The
// app's own precache below is the part that must not be delayed.
const HOSTED_FETCH_TIMEOUT_MS = 6000;

function fetchWithDeadline(url) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctl) ctl.abort(); }, HOSTED_FETCH_TIMEOUT_MS);
  // No `no-cors`: these are same-origin, so the response is a real one whose
  // status we can check. Opaque responses were the old cross-origin shape, and
  // they are both uninspectable and padded heavily against the storage quota.
  return fetch(url, { cache: 'reload', ...(ctl ? { signal: ctl.signal } : {}) })
    .finally(() => clearTimeout(timer));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Best-effort and deadlined — a platform route that is slow or not yet
    // answering must not stop, or even slow, this app's own shell being
    // precached.
    const assets = await caches.open(ASSET_CACHE);
    await Promise.all(HOSTED_ASSETS.map(async url => {
      try {
        const res = await fetchWithDeadline(url);
        if (res && res.ok) await assets.put(url, res.clone());
      } catch (_) { /* unreachable or too slow — the online path fills it in */ }
    }));
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

  // Navigations. CACHE-FIRST for an in-app load, network-first otherwise.
  //
  // Cache-first is the whole slow-network fix (docs/app-slow-network-loading.md):
  // a weak signal never FAILS, it crawls, so network-first holds a blank screen
  // for as long as the connection wants — which is why this app is quick on
  // wifi, quick offline, and painful in between. Offline is fast only because
  // failure is fast.
  //
  // It is conditional because `/` on this origin is polymorphic: the public
  // landing page for a logged-out visitor, the app for an authenticated one
  // (see the catch-all in server.js). A blanket cache-first would serve the
  // app shell to someone who should be seeing the landing page, on any device
  // that had ever opened the app. The platform's iframe always carries
  // `?token=` when online — which is precisely the load that has to be fast on
  // a weak signal — so that flag is the tell, and a token-less navigation
  // keeps exactly the behaviour it has today.
  //
  // The background refresh goes through refreshShell(), which re-fetches the
  // token-less /index.html: nothing token-bearing is ever written to a cache.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      if (url.searchParams.has('token')) {
        const shell = await caches.match(SHELL_URL, { cacheName: SHELL_CACHE });
        if (shell) {
          event.waitUntil(refreshShell());
          return shell;
        }
      }
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
    // The platform's own files share this origin but are not this app's, so
    // they keep their own cache — the split ASSET_CACHE always drew, back when
    // the only thing that told them apart was the hostname.
    if (isHostedAsset(url.pathname)) {
      event.respondWith(staleWhileRevalidate(ASSET_CACHE, req).catch(() => fetch(req)));
      return;
    }
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
