// Service worker client. Production builds register <base>sw.js (src/sw.js, filled in by the `logged:sw`
// plugin in vite.config.ts); the dev server never runs one. Also:
//  - hands the worker what this page fetched before it took control (first visit), so a pincode
//    opened once is there offline;
//  - a newer deploy taking over a page still running the old build gets a quiet "Updated" + Reload;
//  - a chunk that no longer exists after a deploy reloads the page once;
//  - remembers when the forecast on screen is the worker's offline copy (offlineForecastTime).

const BASE = import.meta.env.BASE_URL;

/** this page's build id (index.html <meta name="logged-build">, written by the build) */
const pageBuild = () => document.querySelector<HTMLMetaElement>('meta[name="logged-build"]')?.content ?? '';

/** fetch time of the forecast copy the worker answered with because the network failed (null: live) */
let offlineAt: number | null = null;

/**
 * When the forecast on screen is not live, the time that copy was fetched; null when it is live.
 * Not live: the service worker answered from its cache because the network failed, or the browser is
 * offline (then `fetchedAt`, the time the app's own copy was fetched).
 */
export function offlineForecastTime(fetchedAt?: number): number | null {
  if (offlineAt !== null) return offlineAt;
  return typeof navigator !== 'undefined' && navigator.onLine === false && fetchedAt ? fetchedAt : null;
}

/** what the worker keeps: the app's data, forecasts, basemap tiles and fonts (src/sw.js decides per URL) */
const WARM = /\/data\/|open-meteo\.com\/|tiles\.openfreemap\.org\/|elevation-tiles-prod|fonts\.(googleapis|gstatic)\.com\//;

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker;
  if (!import.meta.env.PROD) {
    // dev server: never let a worker left by a preview build on this origin answer for it
    void sw.getRegistrations().then((rs) => rs.forEach((r) => void r.unregister()), () => {});
    return;
  }
  reloadOnStaleChunk();
  const hadController = !!sw.controller;
  sw.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; fetchedAt?: number; build?: string } | null;
    if (d?.type === 'offline-forecast' && typeof d.fetchedAt === 'number') offlineAt = d.fetchedAt;
    else if (d?.type === 'live-forecast') offlineAt = null;
    else if (d?.type === 'activated' && d.build && pageBuild() && d.build !== pageBuild()) showUpdated();
  });
  sw.startMessages();
  sw.addEventListener('controllerchange', () => {
    // first install: the page loaded before the worker existed, so hand it what was fetched so far
    if (hadController) return;
    const urls = performance.getEntriesByType('resource').map((r) => r.name).filter((u) => WARM.test(u));
    navigator.serviceWorker.controller?.postMessage({ type: 'warm', urls: [...new Set(urls)] });
  });
  const register = () => void sw.register(`${BASE}sw.js`, { scope: BASE }).catch((e) => console.warn('[sw] registration failed', e));
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

/**
 * After a deploy, an open page can ask for a chunk of its old build that the host no longer serves.
 * Vite reports it as `vite:preloadError`: reload once (the new index.html names the new chunks); a
 * second failure within a minute is shown as the usual error instead of looping.
 */
function reloadOnStaleChunk() {
  window.addEventListener('vite:preloadError', (e) => {
    const k = 'logged:chunk-reload';
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(k)) || 0;
      if (Date.now() - last < 60_000) return;
      sessionStorage.setItem(k, String(Date.now()));
    } catch {
      return;
    }
    e.preventDefault();
    location.reload();
  });
}

/** quiet note that a newer version is in place; the page keeps working until the reader reloads */
function showUpdated() {
  if (document.getElementById('sw-updated')) return;
  const el = document.createElement('div');
  el.id = 'sw-updated';
  el.className = 'glass';
  el.setAttribute('role', 'status');
  el.style.cssText =
    'position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:60;display:flex;align-items:center;gap:10px;padding:6px 6px 6px 16px;border-radius:999px;font-size:13px;';
  el.innerHTML = '<span>Updated</span><button type="button" class="btn primary" style="width:auto;height:30px;font-size:13px">Reload</button>';
  el.querySelector('button')!.addEventListener('click', () => location.reload());
  document.body.append(el);
}
