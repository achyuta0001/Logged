// Entry point: the persistent shell (loader, sidebar, rail, timeline, layout) and region navigation.
// The city overview renders from this chunk plus the maplibre-gl vendor chunk. The pincode view
// (src/main.ts: flood engine client, impact, story, tour, place, analysis layers, water and rain
// effects) is a separate chunk, loaded with import() the first time a pincode opens.
import './style.css';
import type { Region, Shell } from './main';
import { Loader } from './ui/loader';
import { Sidebar } from './ui/sidebar';
import { Layout } from './ui/layout';
import { Timeline } from './ui/timeline';
import { LEGACY_PIN, loadPinIndex, packBase, packsRoot } from './region/packs';
import { loadCity, openCity } from './region/city';
import { registerServiceWorker } from './sw-register';
import { withoutCommute } from './ui/commute/state';
import { initInstallHint, noteOpen } from './ui/installHint';

/** go() target for the Commute tab (pincodes are six digits, so it never clashes) */
const COMMUTE = 'commute';

async function boot() {
  const loader = new Loader();
  let region: Region | null = null;
  const sidebar = new Sidebar(document.getElementById('sidebar')!, document.getElementById('rail')!, {
    onTour: () => region?.onTour?.(),
    onFocus: () => layout.toggleFocus(),
    onStatus: () => region?.onStatus?.(),
    onFootprint: () => region?.reframe(),
    onBack: () => go(null),
    // Explore returns to the pincode (or overview) the reader left for Commute
    onTab: (t) => go(t === 'commute' ? COMMUTE : lastPin),
  });
  const timelineEl = document.getElementById('timeline')!;
  const timeline = new Timeline(timelineEl, {
    onHour: (h) => region?.setHour?.(h),
    onPlay: (p) => region?.setPlaying?.(p),
    onSpeed: (s) => region?.setSpeed?.(s),
    onCompact: () => region?.reframe(),
  });
  const layout = new Layout(sidebar, timeline, timelineEl, document.getElementById('focus-bar')!, {
    onFrame: () => region?.reframe(),
    onPlay: () => region?.togglePlay?.(),
    busy: () => !!region?.busy?.(),
  });
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.defaultPrevented || region?.busy?.() || !region?.togglePlay) return; // Space pauses the tour instead
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || t.closest('input, textarea, select, button, a, [role="slider"]'))) return;
    e.preventDefault();
    region.togglePlay();
  });

  loader.set(0.02, 'Loading the pincode index');
  const root = packsRoot();
  const [index, city] = await Promise.all([loadPinIndex(root), loadCity()]);
  /** ?pin=<code>&scenario=<id>&basemap=satellite&view=lng,lat,zoom[,pitch,bearing] (scenario/basemap/view apply to the first region opened) */
  const shell: Shell = { loader, sidebar, timeline, timelineEl, layout, index, hasCity: !!city, go, url: new URLSearchParams(location.search) };

  // navigation is serialised: a region is fully torn down before the next one loads
  let nav = Promise.resolve();
  let first = true;
  let lastPin: string | null = null;
  function go(target: string | null, push = true) {
    nav = nav.then(async () => {
      const commute = target === COMMUTE;
      let pin = commute ? null : target;
      if (!commute && !pin && !city) pin = LEGACY_PIN;
      const entry = pin ? index.pins.find((p) => p.code === pin) : undefined;
      if (pin && !entry?.pack) {
        // unknown pincode, or one without a data pack: fall back to the overview (or 560098 without one)
        console.warn(`[app] no data pack for ${pin}`);
        if (!city) pin = LEGACY_PIN;
        else pin = null;
      }
      if (push) {
        // leaving Commute drops its parameters; ?from&to&dep alone still belong to a pincode's commute check
        const q = new URLSearchParams(!commute && new URLSearchParams(location.search).has('commute') ? withoutCommute(location.search) : location.search);
        if (commute) q.set('commute', '1');
        if (pin) q.set('pin', pin);
        else q.delete('pin');
        if (!first) for (const k of ['scenario', 'view']) q.delete(k);
        const next = `${location.pathname}${q.toString() ? `?${q}` : ''}${location.hash}`;
        if (next !== `${location.pathname}${location.search}${location.hash}`) history[first ? 'replaceState' : 'pushState']({ pin }, '', next);
      }
      if (!first) shell.url = new URLSearchParams();
      first = false;
      try {
        region?.destroy();
      } catch (e) {
        console.error('[app] teardown', e);
      }
      region = null;
      layout.setFocus(false);
      try {
        const e = pin ? index.pins.find((p) => p.code === pin)! : undefined;
        if (!commute) lastPin = pin;
        // the pincode view and the Commute tab are chunks of their own: fetched (or taken from the service worker's cache) on first use
        region = commute
          ? await (await import('./ui/commute/view')).openCommute(shell, city)
          : e
            ? await (await import('./main')).openPin(shell, e, packBase(root, e))
            : await openCity(shell, city!);
        if (commute || e) noteOpen();
      } catch (err) {
        console.error(err);
        // a tab opened before a deploy runs old code against the new packs: reload into the new build
        if (await staleBuild()) {
          loader.error('This page is out of date after a site update. Reloading…');
          location.reload();
          return;
        }
        const back = (!!pin || commute) && !!city;
        loader.error(`Could not load ${commute ? 'the commute view' : pin ? `pincode ${pin}` : 'the city overview'}: ${err instanceof Error ? err.message : String(err)}${back ? '. Back to the overview in a moment.' : ''}`);
        if (back) setTimeout(() => go(null), 3500);
      }
    });
  }
  window.addEventListener('popstate', () => {
    const q = new URLSearchParams(location.search);
    go(q.has('commute') ? COMMUTE : q.get('pin'), false);
  });
  const asked = shell.url.has('commute') ? COMMUTE : shell.url.get('pin');
  go(asked ?? (city ? null : LEGACY_PIN));
}

boot().catch((e) => {
  console.error(e);
  new Loader().error(`Could not start: ${e instanceof Error ? e.message : String(e)}`);
});
registerServiceWorker();
initInstallHint();

/**
 * True when the site now serves a different build than the one running (its index.html points at
 * another entry script). At most one reload a minute, so a broken deploy cannot loop.
 */
async function staleBuild(): Promise<boolean> {
  const KEY = 'logged:stale-reload';
  try {
    if (Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < 60_000) return false;
    const r = await fetch(`${import.meta.env.BASE_URL}index.html`, { cache: 'no-store' });
    if (!r.ok) return false;
    const src = (await r.text()).match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];
    if (!src || new URL(src, location.href).pathname === new URL(import.meta.url).pathname) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}
