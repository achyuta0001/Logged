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

async function boot() {
  const loader = new Loader();
  let region: Region | null = null;
  const sidebar = new Sidebar(document.getElementById('sidebar')!, document.getElementById('rail')!, {
    onTour: () => region?.onTour?.(),
    onFocus: () => layout.toggleFocus(),
    onStatus: () => region?.onStatus?.(),
    onFootprint: () => region?.reframe(),
    onBack: () => go(null),
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
  function go(pin: string | null, push = true) {
    nav = nav.then(async () => {
      if (!pin && !city) pin = LEGACY_PIN;
      const entry = pin ? index.pins.find((p) => p.code === pin) : undefined;
      if (pin && !entry?.pack) {
        // unknown pincode, or one without a data pack: fall back to the overview (or 560098 without one)
        console.warn(`[app] no data pack for ${pin}`);
        if (!city) pin = LEGACY_PIN;
        else pin = null;
      }
      if (push) {
        const q = new URLSearchParams(location.search);
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
        // the pincode view is its own chunk: fetched (or taken from the service worker's cache) on first use
        region = e ? await (await import('./main')).openPin(shell, e, packBase(root, e)) : await openCity(shell, city!);
      } catch (err) {
        console.error(err);
        const back = !!pin && !!city;
        loader.error(`Could not load ${pin ? `pincode ${pin}` : 'the city overview'}: ${err instanceof Error ? err.message : String(err)}${back ? '. Back to the overview in a moment.' : ''}`);
        if (back) setTimeout(() => go(null), 3500);
      }
    });
  }
  window.addEventListener('popstate', () => go(new URLSearchParams(location.search).get('pin'), false));
  const asked = shell.url.get('pin');
  go(asked ?? (city ? null : LEGACY_PIN));
}

boot().catch((e) => {
  console.error(e);
  new Loader().error(`Could not start: ${e instanceof Error ? e.message : String(e)}`);
});
registerServiceWorker();
