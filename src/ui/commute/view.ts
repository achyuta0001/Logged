// The Commute tab: a region like the city overview (src/region/city.ts), with its own map. The
// sidebar holds "My commute" (src/ui/commute/panel.ts); the header's one-line answer is the plan's
// advice ("Leave by 17:45"); the map shows every hotspot coloured by level, the candidate routes and
// the chosen one coloured where it meets water; a bar scrubs the next three hours.
// Data comes through src/ui/commute/adapters.ts (engine and router, or their stand-ins).
import type { MapMouseEvent } from 'maplibre-gl';
import type { Region, Shell } from '../../main';
import type { CityData } from '../../region/city';
import type { LngLat } from '../../commute/spots';
import type { Advice, CommuteHotspot, CommutePlan, HotspotOutlook, RiskLevel, RouteCandidate } from '../../commute/types';
import { BLR_BBOX } from '../../commute/spots';
import { pointInGeometry } from '../../commute/near';
import { fmtHHMM } from '../../commute/verdict';
import { searchPins } from '../../region/packs';
import { createMap, beforeLabels } from '../../map/mapView';
import { WEATHER_ATTRIBUTION, WEATHER_ATTRIBUTION_URL } from '../../weather';
import { esc } from '../format';
import { backend, floorBucket, levelAt, BUCKET_MS } from './adapters';
import { rank, worstLevel } from './levels';
import { Ends, HotspotPins, RouteLines } from './mapLayers';
import { CommutePanel, type End, type PlaceHit } from './panel';
import { Scrubber, type Step } from './scrubber';
import { dayWord, legs, linkHasTrip, loadState, saveState, shareSearch, stateFromSearch, withoutCommute, type CommuteState, type Leg } from './state';
import './commute.css';

const H = 3600e3;
const ACCENT = '#64d2ff';
const ADVICE_COLOR: Record<CommutePlan['advice']['kind'], string> = { go: '#30d158', use_route: '#ffd60a', leave_by: '#ffd60a', leave_after: '#ffd60a', wfh: '#ff453a' };
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export async function openCommute(shell: Shell, city: CityData | null): Promise<Region> {
  const { loader, sidebar, layout, index } = shell;
  let disposed = false;
  loader.setTitle('Commute', 'Rain and waterlogging on your commute');
  loader.show('Loading the commute hotspots');
  loader.set(0.15);
  sidebar.setScope('commute');
  sidebar.setRegion('Commute', 'Home and office', { title: 'My commute', tour: false });
  sidebar.setCaveat(null);
  sidebar.setRange('');
  shell.timelineEl.hidden = true;
  document.title = 'Commute · Bengaluru Flood Explorer';

  // a shared trip replaces what is saved; the address bar keeps only ?commute=1
  const search = location.search;
  let state: CommuteState = linkHasTrip(search) ? stateFromSearch(search)! : loadState();
  if (linkHasTrip(search)) saveState(state);
  {
    const q = new URLSearchParams(withoutCommute(search));
    q.delete('pin');
    q.set('commute', '1');
    history.replaceState(history.state, '', `${location.pathname}?${q}${location.hash}`);
  }

  // ---------------------------------------------------------------- map
  const [w, s, e, n] = BLR_BBOX;
  const boundary: GeoJSON.Geometry = city?.district.geometry ?? { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
  const map = await createMap(document.getElementById('map')!, boundary, 1.4, [(w + e) / 2, (s + n) / 2], { demMaxZoom: 10 });
  loader.set(0.55);
  const hsPromise = backend.loadHotspots();
  const routes = new RouteLines(map, beforeLabels(), (id) => chooseRoute(id));
  const pins = new HotspotPins(map, (id) => {
    if (!picking) openWhy(id, false);
  });
  const ends = new Ends(map, (end, p) => panel.setEnd(end, labelFor(p), p));
  const scrubber = new Scrubber(document.body, (k) => {
    step = k;
    drawPins();
    showCity();
  });

  // ---------------------------------------------------------------- places
  const labelFor = (p: LngLat): string => {
    const f = city?.pins.features.find((x) => pointInGeometry(p, x.geometry));
    const nm = f?.properties.name && !/^Pincode \d+$/.test(f.properties.name) ? f.properties.name : f?.properties.code;
    return nm ? `Near ${nm}` : `${p[1].toFixed(4)}, ${p[0].toFixed(4)}`;
  };
  const searchPlaces = (q: string): PlaceHit[] => {
    const m = /^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{2,3}\.\d+)\s*$/.exec(q);
    if (m) {
      const p: LngLat = [Number(m[2]), Number(m[1])];
      return [{ label: `${p[1].toFixed(4)}, ${p[0].toFixed(4)}`, sub: labelFor(p), coord: p }];
    }
    const nq = q.toLowerCase().trim();
    return searchPins(index, q, 6).map((p) => {
      const loc = /^\d/.test(nq) ? p.name : ([p.name, ...(p.localities ?? [])].find((x) => x.toLowerCase().includes(nq)) ?? p.name);
      return { label: loc, sub: loc === p.name ? `Pincode ${p.code}` : `${p.name} · ${p.code}`, coord: p.centroid };
    });
  };

  // ---------------------------------------------------------------- panel
  let picking: End | null = null;
  const stopPicking = () => {
    picking = null;
    map.getCanvas().style.cursor = '';
    document.body.classList.remove('cm-picking');
  };
  const panel = new CommutePanel(sidebar.body('commute'), state, {
    change(next) {
      state = next;
      saveState(state);
      ends.set('home', state.home?.coord ?? null, state.home?.label ?? '');
      ends.set('office', state.office?.coord ?? null, state.office?.label ?? '');
      void refreshTrip(true);
    },
    search: searchPlaces,
    pick(end) {
      picking = end;
      map.getCanvas().style.cursor = 'crosshair';
      document.body.classList.add('cm-picking');
      panel.say(`Tap the map where your ${end} is. Esc cancels.`);
      sidebar.getOutOfTheWay();
    },
    locate(end) {
      if (!('geolocation' in navigator)) return panel.say('This browser cannot share your location. Search or pick on the map instead.', 'error');
      panel.say('Finding your location…');
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (disposed) return;
          const p: LngLat = [pos.coords.longitude, pos.coords.latitude];
          if (p[0] < BLR_BBOX[0] - 0.4 || p[0] > BLR_BBOX[2] + 0.4 || p[1] < BLR_BBOX[1] - 0.4 || p[1] > BLR_BBOX[3] + 0.4) return panel.say('You seem to be outside Bengaluru. Search or pick on the map instead.', 'error');
          panel.say('');
          panel.setEnd(end, labelFor(p).replace(/^Near /, 'My location · '), p);
        },
        (err) => !disposed && panel.say(err.code === err.PERMISSION_DENIED ? 'Location permission was declined. Search or pick on the map instead.' : 'Could not get your location. Search or pick on the map instead.', 'error'),
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
      );
    },
    route: (id) => chooseRoute(id),
    leg(id) {
      legId = id;
      void refreshTrip(true);
    },
    hotspot: (id) => (id ? openWhy(id, true) : closeWhy()),
    async share() {
      const url = `${location.origin}${location.pathname}${shareSearch(location.search, state)}`;
      try {
        await navigator.clipboard.writeText(url);
        return true;
      } catch {
        return false;
      }
    },
  });
  const onMapClick = (ev: MapMouseEvent) => {
    if (!picking) return;
    const p: LngLat = [ev.lngLat.lng, ev.lngLat.lat];
    const end = picking;
    stopPicking();
    panel.say('');
    panel.setEnd(end, labelFor(p), p);
  };
  map.on('click', onMapClick);
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape' && picking) {
      stopPicking();
      panel.say('');
    }
  };
  document.addEventListener('keydown', onKey, true);
  ends.set('home', state.home?.coord ?? null, state.home?.label ?? '');
  ends.set('office', state.office?.coord ?? null, state.office?.label ?? '');

  // ---------------------------------------------------------------- data: the city's next 3 hours
  let hs: CommuteHotspot[] = [];
  let byId = new Map<string, CommuteHotspot>();
  let cityOut = new Map<string, HotspotOutlook>();
  let steps: Step[] = [];
  let step = 0;
  /** hotspot id -> level when the commuter reaches it on the chosen route */
  let onRoute = new Map<string, RiskLevel>();
  let whyId: string | null = null;

  const stepLevel = (id: string): RiskLevel => (steps[step] ? (levelAt(cityOut.get(id), steps[step].t) ?? 'clear') : 'clear');
  const drawPins = () => pins.set(hs, (id) => onRoute.get(id) ?? stepLevel(id));
  function showCity() {
    if (!steps[step]) return;
    const items = hs.map((h) => ({ h, level: stepLevel(h.id) })).filter((x) => rank(x.level) > 0);
    items.sort((a, b) => rank(b.level) - rank(a.level) || b.h.reportDays - a.h.reportDays);
    panel.showCity(items, step === 0 ? 'now' : `at ${fmtHHMM(steps[step].t)}`);
  }
  async function refreshCity() {
    const now = Date.now();
    const os = await backend.outlooks(hs, now, 3);
    if (disposed) return;
    cityOut = new Map(os.map((o) => [o.id, o]));
    const t0 = floorBucket(now);
    steps = Array.from({ length: 6 }, (_, k) => {
      const t = t0 + k * BUCKET_MS;
      const ls = os.map((o) => levelAt(o, t) ?? 'clear');
      return { t, worst: worstLevel(ls), n: ls.filter((l) => rank(l) > 0).length };
    });
    scrubber.set(steps);
    drawPins();
    showCity();
    if (whyId) openWhy(whyId, false, false);
  }

  // ---------------------------------------------------------------- the trip
  let legId: Leg['id'] | null = null;
  let rs: RouteCandidate[] = [];
  let plan: CommutePlan | null = null;
  /** the outlooks the plan was made from (cover the departure, unlike the city's next three hours) */
  let tripOut = new Map<string, HotspotOutlook>();
  let chosen: RouteCandidate['id'] | null = null;
  let leg: Leg | null = null;
  let seq = 0;
  const legName = (l: Leg) => `${l.from.label.replace(/^(Near|My location ·) /, '')} → ${l.to.label.replace(/^(Near|My location ·) /, '')}`;

  function setIdleStatus() {
    const missing = !state.home && !state.office ? 'home and office' : !state.home ? 'home' : 'office';
    sidebar.setRegion('Commute', 'Home and office', { title: 'My commute', tour: false });
    sidebar.setStatus('none', `<b>Set your ${missing}</b> to check the commute`, 'Waterlogging on the way, from the rain forecast and past flood reports', undefined, ACCENT);
  }

  async function refreshTrip(fit: boolean) {
    const my = ++seq;
    const now = Date.now();
    const ls = legs(state, now);
    if (!ls.length) {
      rs = [];
      plan = null;
      chosen = null;
      leg = null;
      onRoute = new Map();
      routes.set([], null, null);
      panel.showRoutes(null, [], null, 0, byId);
      panel.showLeaveStrip([], '', 'out');
      panel.showLegs([], null, now, dayWord);
      drawPins();
      setIdleStatus();
      return;
    }
    leg = ls.find((l) => l.id === legId) ?? ls[0];
    legId = leg.id;
    panel.showLegs(ls, leg.id, now, dayWord);
    sidebar.setRegion('Commute', legName(leg), { title: 'My commute', tour: false });
    sidebar.setStatus('none', 'Checking your commute', `${dayWord(leg.departure, now)} ${leg.hhmm}`, undefined, ACCENT);
    try {
      const found = await backend.routes(leg.from.coord, leg.to.coord);
      if (my !== seq || disposed) return;
      const longest = Math.max(0, ...found.map((r) => r.durationS)) * 1000;
      const t0 = Math.max(floorBucket(now), leg.departure - 2.5 * H);
      const os = await backend.outlooks(hs, t0, (leg.departure + 3.5 * H + longest - t0) / H);
      if (my !== seq || disposed) return;
      rs = found;
      tripOut = new Map(os.map((o) => [o.id, o]));
      plan = backend.plan(rs, hs, os, leg.departure, now);
      chosen = plan.advice.kind === 'use_route' ? plan.advice.route : (rs[0]?.id ?? null);
      // best time to leave: every 15 min within 2 h either side, the least risky route at each
      const strip: { hhmm: string; level: RiskLevel }[] = [];
      for (let m = -120; m <= 120; m += 15) {
        const d = leg.departure + m * 60e3;
        if (d < now) continue;
        const p = backend.plan(rs, hs, os, d, now);
        const best = p.routes.reduce<RiskLevel | null>((acc, r) => (acc === null || rank(r.level) < rank(acc) ? r.level : acc), null);
        if (best) strip.push({ hhmm: fmtHHMM(d), level: best });
      }
      panel.showLeaveStrip(strip, leg.hhmm, leg.id);
      panel.say('');
      render(fit);
    } catch (err) {
      if (my !== seq || disposed) return;
      console.error('[commute]', err);
      panel.say(`Could not check the commute: ${err instanceof Error ? err.message : String(err)}`, 'error');
      sidebar.setStatus('none', '<b>Could not check</b> the commute', 'The forecast or the route did not load. Try again in a moment.', undefined, '#8e8e93');
    }
  }

  function render(fit: boolean) {
    if (!plan || !leg) return;
    const now = Date.now();
    const risk = plan.routes.find((r) => r.route === chosen) ?? null;
    onRoute = new Map((risk?.hits ?? []).map((h) => [h.id, h.level]));
    routes.set(rs, chosen, risk);
    drawPins();
    const advised = plan.advice.kind === 'use_route' ? plan.advice.route : undefined;
    panel.showRoutes(rs, plan.routes, chosen, plan.departure, byId, advised);
    const a = plan.advice;
    const first = plan.routes[0];
    const covered = !first || first.hits.every((h) => levelAt(tripOut.get(h.id), plan!.departure + h.atS * 1000) !== null);
    sidebar.setRegion('Commute', `${legName(leg)} · ${dayWord(plan.departure, now)} ${fmtHHMM(plan.departure)}`, { title: 'My commute', tour: false });
    sidebar.setStatus('none', `<b>${esc(headline(a, covered))}</b>`, a.text.includes('Advisory') ? a.text : `${a.text} Advisory only.`, 'Show the routes', covered ? ADVICE_COLOR[a.kind] : '#8e8e93');
    if (fit) frameTrip();
  }

  /** the one big line: short, from the advice kind; the planner's sentence goes underneath */
  function headline(a: Advice, covered: boolean): string {
    switch (a.kind) {
      case 'go':
        if (!covered) return 'No forecast for that time yet';
        return plan?.routes[0]?.hits.some((h) => h.level === 'watch') ? 'Go, but watch for water' : 'Go — no waterlogging expected';
      case 'leave_by':
        return `Leave by ${fmtHHMM(a.at)}`;
      case 'leave_after':
        return `Leave after ${fmtHHMM(a.at)}`;
      case 'use_route': {
        const via = rs.find((r) => r.id === a.route)?.via;
        return `Use route ${a.route}${via ? ` (${via})` : ''}`;
      }
      case 'wfh':
        return 'Consider working from home';
    }
  }

  function chooseRoute(id: RouteCandidate['id']) {
    if (!plan || chosen === id) return;
    chosen = id;
    render(false);
  }

  function frameTrip() {
    const pts: LngLat[] = [];
    for (const r of rs) pts.push(...r.line);
    if (!pts.length) {
      if (state.home) pts.push(state.home.coord);
      if (state.office) pts.push(state.office.coord);
    }
    if (!pts.length) return;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    // cameraForBounds fits the free map area: the map's own padding (set first) plus a margin
    map.setPadding(pad());
    const cam = map.cameraForBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 36, maxZoom: 14 });
    if (!cam) return;
    const ms = reduceMotion() ? 0 : 900;
    framingUntil = performance.now() + ms + 100;
    map.easeTo({ center: cam.center, zoom: cam.zoom, pitch: 30, bearing: 0, duration: ms, essential: true });
  }
  /** while the trip is being framed, a change of the free map area (the phone sheet settling) frames it again */
  let framingUntil = 0;

  // ---------------------------------------------------------------- why
  function openWhy(id: string, fromList: boolean, reveal = true) {
    const h = byId.get(id);
    if (!h) return;
    whyId = id;
    pins.select(id);
    const hit = plan?.routes.find((r) => r.route === chosen)?.hits.find((x) => x.id === id);
    panel.showWhy(h, cityOut.get(id), hit && plan ? { t: plan.departure + hit.atS * 1000, level: hit.level } : undefined);
    if (!reveal) return;
    if (layout.mode === 'phone') {
      if (sidebar.minimised) sidebar.setSheet('half');
    } else sidebar.setMinimised(false);
    sidebar.setOpen('commute', true);
    if (fromList) {
      map.easeTo({ center: h.coord, zoom: Math.max(map.getZoom(), 13), padding: pad(), duration: reduceMotion() ? 0 : 700, essential: true });
      panel.focusWhy();
    } else (sidebar.body('commute').querySelector('.cm-why') as HTMLElement)?.scrollIntoView({ block: 'nearest' });
  }
  function closeWhy() {
    whyId = null;
    pins.select(null);
    panel.showWhy(null, undefined);
  }

  // ---------------------------------------------------------------- framing
  const pad = () => {
    const p = layout.padding();
    const sh = scrubber.el.hidden ? 0 : scrubber.el.offsetHeight + 10;
    return { ...p, bottom: (p.bottom ?? 0) + sh };
  };

  // sources
  const st = () => backend.status();
  const renderSources = () => {
    const s0 = st();
    sidebar.body('sources').innerHTML = `<ul class="src-list">
      <li><span>Rain</span><p><a href="${WEATHER_ATTRIBUTION_URL}" target="_blank" rel="noopener">${esc(WEATHER_ATTRIBUTION)}</a>. ${esc(s0.forecast)}</p></li>
      <li><span>Hotspots</span><p>${esc(s0.hotspots)}; each links its reports.</p></li>
      <li><span>Levels</span><p>Rain in each half hour against the rain at which that kind of place starts to waterlog, raised for a wet day before, low ground and past reports (src/commute/config.ts). An estimate, not a measurement.</p></li>
      <li><span>Routes</span><p>${esc(s0.routes)}; roads © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> (ODbL 1.0)</p></li>
      <li><span>Basemap</span><p><a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>, © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a>, © OpenStreetMap contributors</p></li>
    </ul>`;
    sidebar.setSummary('sources', 'Open-Meteo · OSM · news');
  };

  // first frame: the district, or the trip
  map.setPadding(layout.padding());
  const cam = map.cameraForBounds([[w, s], [e, n]], { padding: 24 });
  if (cam) map.jumpTo({ center: cam.center, zoom: cam.zoom, pitch: 30, bearing: 0 });
  try {
    hs = await hsPromise;
  } catch (err) {
    console.error('[commute] hotspots', err);
    hs = [];
  }
  if (disposed) return deadRegion();
  byId = new Map(hs.map((h) => [h.id, h]));
  loader.set(0.8);
  sidebar.setSummary('commute', '');
  setIdleStatus();
  await refreshCity().catch((err) => {
    console.error('[commute] forecast', err);
    panel.say('The rain forecast did not load, so levels cannot be worked out right now.', 'error');
    scrubber.setHidden(true);
  });
  void refreshTrip(true).then(renderSources);
  renderSources();
  loader.hide();
  const tick = window.setInterval(() => {
    void refreshCity().catch(() => {});
    void refreshTrip(false);
  }, 10 * 60e3);

  function deadRegion(): Region {
    return { kind: 'commute', reframe() {}, destroy() {} };
  }

  return {
    kind: 'commute',
    reframe() {
      if (disposed) return;
      // a re-pad in the middle of framing the trip would stop that animation half way: frame again
      if (performance.now() < framingUntil) return frameTrip();
      map.easeTo({ padding: pad(), duration: reduceMotion() ? 0 : 450, essential: true });
    },
    onStatus() {
      if (layout.mode === 'phone') sidebar.setSheet('half');
      else sidebar.setMinimised(false);
      sidebar.reveal('commute');
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      clearInterval(tick);
      document.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('cm-picking');
      map.off('click', onMapClick);
      scrubber.destroy();
      pins.destroy();
      routes.destroy();
      ends.destroy();
      map.remove();
      sidebar.clearBodies();
      shell.timelineEl.hidden = false;
    },
  };
}
