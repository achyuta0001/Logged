/* Service worker (hand-written, no dependencies). The build (plugin `logged:sw` in vite.config.ts)
 * writes it to <base>sw.js with BUILD, SHELL and DATA filled in; src/sw-register.ts registers it in
 * production builds only.
 *
 * BUILD is a hash of every emitted file and everything in public/ (packs, index, city overview), so a
 * deploy that changes code or data is a new worker. Caches (all named logged-*; activate deletes every
 * one this version does not use):
 *   logged-shell-<build>  index.html, every hashed JS/CSS/worker file, the manifest and icons.
 *                         Precached on install; cache-first.
 *   logged-data-<build>   <base>data/**: pin index, city overview, pincode packs. Cache-first, filled
 *                         with revalidated responses; index + overview precached. At most MAX_PACKS
 *                         packs, the least recently opened go first.
 *   logged-roads          the city road graph, <base>data/roads/graph-<hash>.bin.gz (src/route/). Named by
 *                         its content, so cache-first across deploys; a new graph replaces the old.
 *                         Its index.json (which names the file) is data, above.
 *   logged-forecast       Open-Meteo, network-first: the cached copy only when the network fails or
 *                         hangs (the page then shows "Offline · forecast from <time>").
 *   logged-tiles          OpenFreeMap basemap (style, TileJSON, tiles, glyphs, sprites), AWS terrain
 *                         tiles, Google Fonts: cache-first for files, stale-while-revalidate for the
 *                         style, TileJSON and font CSS. At most MAX_TILES entries.
 * Navigations are network-first (revalidated, so never a stale index.html while online); the cached
 * index.html is only the offline (or hung network) fallback, and it always matches the cached shell.
 * When the live index.html names a newer build, this worker stops answering data from its cache
 * (network-first instead) and fetches the new worker.
 */
/* eslint-disable */
const BUILD = /* @build */ 'dev';
const SHELL = /* @shell */ [];
const DATA = /* @data */ [];

const SCOPE = new URL(self.registration.scope);
const BASE = SCOPE.pathname;
const SHELL_CACHE = `logged-shell-${BUILD}`;
const DATA_CACHE = `logged-data-${BUILD}`;
const FORECAST_CACHE = 'logged-forecast';
const TILE_CACHE = 'logged-tiles';
const ROADS_CACHE = 'logged-roads';
const KEEP = [SHELL_CACHE, DATA_CACHE, FORECAST_CACHE, TILE_CACHE, ROADS_CACHE];
const MAX_PACKS = 12;
const MAX_FORECASTS = 24;
const MAX_TILES = 600;
const NAV_TIMEOUT_MS = 6000;
const FORECAST_TIMEOUT_MS = 10000;

const abs = (p) => new URL(p, SCOPE).href;
const isHtml = (r) => (r.headers.get('content-type') || '').includes('text/html');
/** a newer build is live: data comes from the network (this cache holds the old build's) */
let outdated = false;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      await Promise.all(
        SHELL.map(async (p) => {
          // hashed files can come from the HTTP cache; index.html, manifest and icons are revalidated
          const res = await fetch(abs(p), { cache: p.startsWith('assets/') ? 'default' : 'no-cache' });
          if (!res.ok) throw new Error(`precache ${p}: HTTP ${res.status}`);
          await shell.put(abs(p), res);
        }),
      );
      const data = await caches.open(DATA_CACHE);
      await Promise.all(
        DATA.map(async (p) => {
          const res = await fetch(abs(p), { cache: 'no-cache' }).catch(() => null);
          if (res && res.ok && !isHtml(res)) await data.put(abs(p), res);
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('logged-') && !KEEP.includes(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
      // a page still running another build offers a reload (src/sw-register.ts)
      for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage({ type: 'activated', build: BUILD });
    })(),
  );
});

self.addEventListener('message', (event) => {
  const d = event.data;
  if (d && d.type === 'warm' && Array.isArray(d.urls)) event.waitUntil(warm(d.urls.slice(0, 400)));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    if (url.origin === SCOPE.origin && (url.pathname === BASE || url.pathname === `${BASE}index.html`)) event.respondWith(navigate(event));
    return;
  }
  if (url.origin === SCOPE.origin) {
    if (isGraph(url)) event.respondWith(roads(event));
    else if (url.pathname.startsWith(`${BASE}data/`)) event.respondWith(data(event));
    else if (url.pathname.startsWith(`${BASE}assets/`) || SHELL.some((p) => abs(p) === url.href)) event.respondWith(shellFirst(req));
    return;
  }
  if (/(^|\.)open-meteo\.com$/.test(url.hostname)) event.respondWith(forecast(event, url));
  else if (tileKind(url)) event.respondWith(tiles(event, url));
});

// ------------------------------------------------------------------------------------------- routes

async function navigate(event) {
  const url = event.request.url;
  let res = null;
  try {
    res = await timeout(fetch(url, { cache: 'no-cache', credentials: 'same-origin' }), NAV_TIMEOUT_MS);
  } catch {
    res = null;
  }
  if (res && res.ok) {
    if (res.redirected) return Response.redirect(res.url, 302);
    event.waitUntil(checkBuild(res.clone()));
    return res;
  }
  const cached = await caches.match(abs('index.html'), { cacheName: SHELL_CACHE });
  return cached || res || Response.error();
}

/** the live index.html names its build; another one means a deploy happened since this worker */
async function checkBuild(res) {
  try {
    const m = /<meta name="logged-build" content="([^"]+)"/.exec(await res.text());
    if (m && m[1] !== BUILD && !outdated) {
      outdated = true;
      await self.registration.update();
    }
  } catch {}
}

async function shellFirst(req) {
  const hit = await caches.match(req, { cacheName: SHELL_CACHE });
  return hit || fetch(req);
}

async function data(event) {
  const req = event.request;
  const cache = await caches.open(DATA_CACHE);
  if (!outdated) {
    const hit = await cache.match(req);
    if (hit) {
      if (packOf(req.url) && /\/meta\.json$/.test(req.url)) event.waitUntil(cache.put(req, hit.clone()).catch(() => {})); // re-put: most recently opened
      return hit;
    }
  }
  try {
    const res = await fetch(new Request(req, { cache: 'no-cache' }));
    if (res.ok && !outdated && !isHtml(res)) event.waitUntil(cache.put(req, res.clone()).then(() => trimPacks(cache), () => {}));
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw e;
  }
}

/** the content-addressed road graph file */
const isGraph = (url) => url.pathname.startsWith(`${BASE}data/roads/graph-`);

/** road graph: immutable per name, so cache-first; storing a new one drops the others */
async function roads(event) {
  const req = event.request;
  const cache = await caches.open(ROADS_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && !isHtml(res)) event.waitUntil(putGraph(cache, req.url, res.clone()));
  return res;
}

async function putGraph(cache, url, res) {
  try {
    await cache.put(url, res);
    for (const k of await cache.keys()) if (k.url !== url) await cache.delete(k);
  } catch {}
}

async function forecast(event, url) {
  const req = event.request;
  const cache = await caches.open(FORECAST_CACHE);
  const isForecast = !url.hostname.startsWith('archive');
  const net = fetch(req).then(async (res) => {
    if (res.ok) {
      await putStamped(cache, req, res.clone());
      if (isForecast) await tell(event, { type: 'live-forecast' });
    }
    return res;
  });
  event.waitUntil(net.catch(() => {}));
  try {
    const res = await timeout(net, FORECAST_TIMEOUT_MS);
    if (res.ok || (res.status < 500 && res.status !== 429)) return res;
  } catch {}
  const hit = await cache.match(req);
  if (!hit) return net;
  if (isForecast) await tell(event, { type: 'offline-forecast', fetchedAt: Number(hit.headers.get('x-logged-fetched')) || 0 });
  return hit;
}

/** OpenFreeMap and AWS terrain tiles: 'file' = immutable (cache-first), 'index' = SWR */
function tileKind(url) {
  const h = url.hostname;
  if (h === 'tiles.openfreemap.org') return /\.\w+$/.test(url.pathname) ? 'file' : 'index';
  if ((h === 's3.amazonaws.com' && url.pathname.startsWith('/elevation-tiles-prod/')) || h === 'elevation-tiles-prod.s3.amazonaws.com') return 'file';
  return null;
}

async function tiles(event, url) {
  const req = event.request;
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req);
  const refresh = () =>
    fetch(req).then((res) => {
      // only CORS-readable answers: an opaque one would count megabytes against the quota
      if (res.ok) event.waitUntil(cache.put(req, res.clone()).then(() => trimTiles(cache), () => {}));
      return res;
    });
  if (hit) {
    if (tileKind(url) === 'index') event.waitUntil(refresh().catch(() => {}));
    return hit;
  }
  return refresh();
}

// ------------------------------------------------------------------------------------------ helpers

function timeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}

async function tell(event, msg) {
  try {
    const c = event.clientId && (await self.clients.get(event.clientId));
    if (c) c.postMessage(msg);
  } catch {}
}

/** store a copy that remembers when it was fetched (x-logged-fetched), newest last */
async function putStamped(cache, req, res) {
  const h = new Headers(res.headers);
  h.set('x-logged-fetched', String(Date.now()));
  await cache.put(req, new Response(await res.arrayBuffer(), { status: res.status, statusText: res.statusText, headers: h }));
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_FORECASTS))) await cache.delete(k);
}

/** pack a data URL belongs to (data/pins/<code>/...), or null for the index, overview and shared files */
function packOf(href) {
  const p = new URL(href).pathname.slice(BASE.length);
  const m = /^data\/pins\/(\d{6})\//.exec(p);
  if (m) return m[1];
  return /^data\/[^/]+\.(json|bin|geojson|gz)$/.test(p) && !/^data\/hotspots-city\.json$/.test(p) ? 'data' : null;
}

/** keep the MAX_PACKS most recently opened packs (key order = last put; meta.json is re-put on use) */
async function trimPacks(cache) {
  const keys = await cache.keys();
  const last = new Map();
  keys.forEach((k, i) => {
    const p = packOf(k.url);
    if (p) last.set(p, i);
  });
  if (last.size <= MAX_PACKS) return;
  const drop = new Set([...last.entries()].sort((a, b) => a[1] - b[1]).slice(0, last.size - MAX_PACKS).map(([p]) => p));
  await Promise.all(keys.filter((k) => drop.has(packOf(k.url))).map((k) => cache.delete(k)));
}

let tilePuts = 0;
async function trimTiles(cache) {
  if (++tilePuts % 40) return; // every 40th put: listing hundreds of keys each time is wasteful
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_TILES)).map((k) => cache.delete(k)));
}

/** first visit: cache what the page fetched before this worker controlled it */
async function warm(urls) {
  const data = await caches.open(DATA_CACHE);
  const fc = await caches.open(FORECAST_CACHE);
  const tl = await caches.open(TILE_CACHE);
  for (const u of urls) {
    try {
      const url = new URL(u);
      if (url.origin === SCOPE.origin && isGraph(url)) {
        const rc = await caches.open(ROADS_CACHE);
        if (await rc.match(u)) continue;
        const res = await fetch(u, { credentials: 'same-origin' });
        if (res.ok && !isHtml(res)) await putGraph(rc, u, res);
      } else if (url.origin === SCOPE.origin && url.pathname.startsWith(`${BASE}data/`)) {
        if (await data.match(u)) continue;
        const res = await fetch(u, { cache: 'no-cache', credentials: 'same-origin' });
        if (res.ok && !isHtml(res)) await data.put(u, res);
      } else if (/(^|\.)open-meteo\.com$/.test(url.hostname)) {
        if (await fc.match(u)) continue;
        const res = await fetch(u);
        if (res.ok) await putStamped(fc, u, res);
      } else if (tileKind(url)) {
        if (await tl.match(u)) continue;
        const res = await fetch(u);
        if (res.ok) await tl.put(u, res);
      }
    } catch {}
  }
  await trimPacks(data);
}
