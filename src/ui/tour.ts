// Cinematic guided flythrough of pincode 560098 + idle "attract mode" orbit.
// Every claim in a caption comes from public/data (model output) or a linked news/BBMP source.
import maplibregl, { type Map as MLMap } from 'maplibre-gl';
import type { Depression, Hotspot } from '../types';
import { esc, fmtArea } from './format';
import { iconSvg } from './icons';
import './story.css';

export interface TourOptions {
  hotspots: Hotspot[];
  depressions: Depression[];
  onStep?(i: number): void;
  /** called when the tour ends (Esc, close button, or after the last stop) */
  onEnd?(): void;
  /** modelled max water depth (m) at a point, from the current simulation run */
  getModelDepthAt?(lng: number, lat: number): number | undefined;
  /** the pincode being toured; anything but 560098 gets the generic, data-driven script */
  region?: { code: string; name: string; center: [number, number] };
}

export interface Tour {
  start(at?: number): void;
  stop(): void;
  next(): void;
  prev(): void;
  goTo(i: number): void;
  pause(): void;
  resume(): void;
  readonly isRunning: boolean;
  readonly index: number;
  readonly length: number;
}

type Kind = 'intro' | 'model' | 'reported';
type HEvent = Hotspot['events'][number];

interface Stop {
  kind: Kind;
  kicker: string;
  title: string;
  text: string;
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  /** degrees of bearing drift while dwelling */
  drift: number;
  dwellMs: number;
  facts?: { v: string; l: string }[];
  reported?: HEvent;
  source?: { href: string; label: string };
  /** point to probe the flood model at (omit for intro) */
  probe?: [number, number];
}

const SRC = {
  dh2019: { href: 'https://www.deccanherald.com/specials/point-blank/monsoon-flood-fury-not-yet-battle-ready-734464.html', label: 'Deccan Herald, 2019' },
  wall: { href: 'https://www.deccanherald.com/india/karnataka/bengaluru/rain-washes-away-retaining-wall-along-vrishabhavathi-853812.html', label: 'Deccan Herald, Jun 2020' },
  oct24: { href: 'https://www.deccanherald.com/india/karnataka/bengaluru/homes-flooded-roads-choked-yet-again-after-another-rain-spell-3240856', label: 'Deccan Herald, Oct 2024' },
  cm22: { href: 'https://www.thenewsminute.com/article/bengaluru-residents-upset-choked-stormwater-drains-lead-flooding-164116', label: 'The News Minute, May 2022' },
};

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- helpers ----------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2024-10-20" -> "20 Oct 2024", "2025-05" -> "May 2025" */
export function fmtEventDate(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  if (!m) return String(y);
  return `${day ? `${day} ` : ''}${MONTHS[m - 1]} ${y}`;
}
export function latestEvent(h: Hotspot): HEvent | undefined {
  return [...h.events].sort((a, b) => b.date.localeCompare(a.date))[0];
}
/** approx metres between two lon/lat points (equirectangular, fine at this scale) */
export function distM(a: [number, number], b: [number, number]): number {
  const k = 111_320;
  const dx = (a[0] - b[0]) * k * Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  const dy = (a[1] - b[1]) * k;
  return Math.hypot(dx, dy);
}
/**
 * Modelled depth for a reported spot. The app's lookup already takes the deepest street
 * water within 300 m (hotspot coordinates are neighbourhood-level), so probe once.
 */
export function probeDepth(fn: ((lng: number, lat: number) => number | undefined) | undefined, c: [number, number]): number | undefined {
  if (!fn) return undefined;
  const v = fn(c[0], c[1]);
  return v !== undefined && Number.isFinite(v) ? v : undefined;
}
export function fmtModelDepth(m: number): string {
  if (m < 0.02) return 'dry';
  return m < 1 ? `${m.toFixed(2)} m` : `${m.toFixed(1)} m`;
}
const fmtVol = (m3: number) => (m3 >= 1e5 ? `${(m3 / 1e6).toFixed(2)} M m³` : `${Math.round(m3 / 1000).toLocaleString('en-IN')}k m³`);
const fmtKm2 = (m2: number) => `${(m2 / 1e6).toFixed(2)} km²`;

function basinFacts(d: Depression) {
  return [
    { v: fmtArea(d.areaM2), l: 'basin area' },
    { v: `${d.maxDepthM.toFixed(1)} m`, l: 'deepest point below spill level (DEM)' },
    { v: fmtVol(d.volumeM3), l: 'water it holds before spilling' },
    { v: fmtKm2(d.catchmentM2), l: 'catchment draining in' },
  ];
}

function nearestReport(hotspots: Hotspot[], c: [number, number], maxM: number): { h: Hotspot; e: HEvent } | undefined {
  let best: { h: Hotspot; e: HEvent; d: number } | undefined;
  for (const h of hotspots) {
    const d = distM(h.coord, c);
    const e = latestEvent(h);
    if (e && d <= maxM && (!best || d < best.d)) best = { h, e, d };
  }
  return best;
}

// ---------- generic script (any pincode) ----------
/**
 * Tour for pincodes without a hand-written script: the biggest terrain basins, then the reported
 * flood spots in the pack's hotspots.json (each with its source). Only facts from the data.
 */
function buildGenericStops(hotspots: Hotspot[], deps: Depression[], region: NonNullable<TourOptions['region']>): Stop[] {
  const stops: Stop[] = [];
  const name = region.name.replace(/^Pincode \d+$/, '').trim();
  const reported = hotspots.filter((h) => latestEvent(h));
  stops.push({
    kind: 'intro',
    kicker: `Pincode ${region.code}${name ? ` · ${name}` : ''}`,
    title: 'Where water collects first',
    text: `The terrain model finds ${deps.length} closed hollows here, where rain pools before it can drain away.${
      reported.length ? ` ${reported.length} place${reported.length === 1 ? ' has' : 's have'} reported flooding in the news.` : ' No sourced flood reports are on file for this pincode yet.'
    } Bengaluru's older storm drains were designed for rain peaks of about 75 mm an hour; recent storms have peaked near 125 mm.`,
    center: region.center,
    zoom: 13.6,
    pitch: 60,
    bearing: -30,
    drift: 70,
    dwellMs: 13000,
    source: SRC.dh2019,
  });
  const used: [number, number][] = [];
  const far = (c: [number, number]) => used.every((u) => distM(u, c) > 600);
  for (const d of [...deps].sort((a, b) => b.volumeM3 - a.volumeM3)) {
    if (stops.length >= 4) break;
    if (!far(d.centroid)) continue;
    used.push(d.centroid);
    const near = nearestReport(hotspots, d.centroid, 450);
    stops.push({
      kind: 'model',
      kicker: `Terrain basin · ${d.label ?? 'unnamed'}`,
      title: stops.length === 1 ? 'The biggest hollow in the pincode' : 'Another low basin',
      text: `In the terrain model, runoff from about ${fmtKm2(d.catchmentM2)} of streets and rooftops drains into this hollow, which sits up to ${d.maxDepthM.toFixed(1)} m below the point where water would spill out.`,
      center: d.centroid,
      zoom: 15.6,
      pitch: 68,
      bearing: [-40, 60, -10][stops.length % 3],
      drift: 14,
      dwellMs: 12000,
      facts: basinFacts(d),
      reported: near?.e,
      source: near ? { href: near.e.source, label: near.h.name } : undefined,
      probe: d.centroid,
    });
  }
  for (const h of reported.slice(0, 3)) {
    const e = latestEvent(h)!;
    stops.push({
      kind: 'reported',
      kicker: `Reported flooding · ${h.name}`,
      title: `${h.name}, ${fmtEventDate(e.date)}`,
      text: e.summary,
      center: h.coord,
      zoom: 15.7,
      pitch: 64,
      bearing: 35,
      drift: -14,
      dwellMs: 12000,
      reported: e,
      source: { href: e.source, label: 'Source' },
      probe: h.coord,
    });
  }
  return stops;
}

// ---------- the script ----------
function buildStops(hotspots: Hotspot[], deps: Depression[]): Stop[] {
  const stops: Stop[] = [];
  const findDep = (re: RegExp) => deps.find((d) => d.label && re.test(d.label));
  const findHot = (re: RegExp) => hotspots.find((h) => re.test(h.name));

  // extent of everything we know about -> opening orbit centre
  const pts = [...hotspots.map((h) => h.coord), ...deps.slice(0, 30).map((d) => d.centroid)];
  const lons = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  const center: [number, number] = pts.length ? [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2] : [77.5157, 12.9157];

  stops.push({
    kind: 'intro',
    kicker: 'Pincode 560098 · Rajarajeshwari Nagar',
    title: 'A neighbourhood built across a river valley',
    text: `Bengaluru's older storm drains were designed for rain peaks of about 75 mm an hour; recent storms have peaked near 125 mm. Here are ${hotspots.length} places where flooding has been reported in RR Nagar, and the low ground the terrain model says fills first.`,
    center,
    zoom: 13.6,
    pitch: 60,
    bearing: -30,
    drift: 70,
    dwellMs: 13000,
    source: SRC.dh2019,
  });

  // Vrishabhavathi: the valley basin with the largest upstream catchment
  const valley = deps.filter((d) => d.label && /vrishabh/i.test(d.label)).sort((a, b) => b.catchmentM2 - a.catchmentM2)[0];
  if (valley)
    stops.push({
      kind: 'model',
      kicker: 'Lowest ground · Vrishabhavathi valley',
      title: 'Where the whole slope drains',
      text: `RR Nagar is a major catchment of the Vrishabhavathi, which runs along Mysuru Road. The terrain model's biggest basins sit on this valley floor; this one collects runoff from ${fmtKm2(valley.catchmentM2)}. In June 2020, heavy inflow washed away a major part of its retaining wall near Mylasandra on Mysuru Road.`,
      center: valley.centroid,
      zoom: 14.9,
      pitch: 66,
      bearing: 25,
      drift: 16,
      dwellMs: 13000,
      facts: basinFacts(valley),
      source: SRC.wall,
      probe: valley.centroid,
    });

  const depStop = (d: Depression | undefined, title: string, lead: string, bearing: number) => {
    if (!d) return;
    const near = nearestReport(hotspots, d.centroid, 450);
    stops.push({
      kind: 'model',
      kicker: `Terrain basin · ${d.label ?? 'unnamed'}`,
      title,
      text: lead,
      center: d.centroid,
      zoom: 15.6,
      pitch: 68,
      bearing,
      drift: 14,
      dwellMs: 12000,
      facts: basinFacts(d),
      reported: near?.e,
      source: near ? { href: near.e.source, label: near.h.name } : undefined,
      probe: d.centroid,
    });
  };
  const beml7 = findDep(/BEML Layout 7th/i);
  depStop(
    beml7,
    'A bowl behind the tech park',
    `A hollow beside Global Village Road, BEML Layout 7th Phase. In the terrain model the ground slopes inward on every side, so rain has nowhere to go until the hollow fills.`,
    -40,
  );
  const ken = findDep(/Kenchenahalli/i);
  depStop(
    ken,
    'Kenchenahalli Main Road',
    `Runoff from about ${ken ? fmtKm2(ken.catchmentM2) : 'a wide area'} of streets and rooftops drains into this hollow in the terrain model.`,
    60,
  );
  const tms = findDep(/TMS Road/i);
  const deepest = tms !== undefined && deps.every((d) => d.maxDepthM <= tms.maxDepthM);
  depStop(
    tms,
    deepest ? 'The deepest hollow in the pincode' : 'A deep hollow on TMS Road',
    `The ground along TMS Road, Channasandra sits about ${tms ? tms.maxDepthM.toFixed(1) : '5'} m below the point where water would spill out.${deepest ? ' It is the deepest closed hollow the terrain model finds in 560098.' : ''}`,
    -10,
  );

  const hotStop = (h: Hotspot | undefined, title: string, text: string, bearing: number, src?: { href: string; label: string }, center?: [number, number], extra: HEvent[] = []) => {
    if (!h) return;
    const e = latestEvent({ ...h, events: [...h.events, ...extra] });
    stops.push({
      kind: 'reported',
      kicker: `Reported flooding · ${h.name}`,
      title,
      text,
      center: center ?? h.coord,
      zoom: 15.7,
      pitch: 64,
      bearing,
      drift: -14,
      dwellMs: 12000,
      reported: e,
      source: src ?? (e ? { href: e.source, label: 'Source' } : undefined),
      probe: h.coord,
    });
  };
  hotStop(
    findHot(/^BEML Layout/i),
    'BEML Layout, 20 October 2024',
    'RR Nagar recorded 177.6 mm of rain that day, more than 140 mm of it overnight, and water entered at least 100 homes in BEML Layout.',
    35,
    SRC.oct24,
  );
  hotStop(
    findHot(/Ideal Homes/i),
    'Ideal Homes Township',
    'Flood reports name this layout in 2019, when an apartment basement filled to about a foot after overnight rain, and again in October 2021.',
    -55,
  );
  const pramod = findHot(/Pramod/i);
  const mysuru = findHot(/Mysuru Road at Nayandahalli/i);
  if (pramod || mysuru) {
    const h = (mysuru ?? pramod)!;
    const mid: [number, number] | undefined = pramod && mysuru ? [(pramod.coord[0] + mysuru.coord[0]) / 2, (pramod.coord[1] + mysuru.coord[1]) / 2] : undefined;
    hotStop(
      { ...h, name: 'Pramod Layout, Nayandahalli and Mysuru Road' },
      'Where the valley meets the highway',
      'Overflowing drains from Hosakerehalli have flooded Pramod Layout, and Mysuru Road at Nayandahalli floods when the valley fills. In May 2022 the Chief Minister said RR Nagar had about 20 storm-drain bottlenecks, along with encroachment.',
      -20,
      SRC.cm22,
      mid,
      pramod && mysuru ? pramod.events : [],
    );
  }
  return stops;
}

/** resolves when the map is idle (tiles + DEM loaded) or after `maxMs` */
function settle(map: MLMap, maxMs: number): Promise<void> {
  return new Promise((res) => {
    const done = () => {
      clearTimeout(t);
      map.off('idle', done);
      res();
    };
    const t = setTimeout(done, maxMs);
    map.once('idle', done);
  });
}

// ---------- tour ----------
export function createTour(map: MLMap, opts: TourOptions): Tour {
  const stops = opts.region && opts.region.code !== '560098' ? buildGenericStops(opts.hotspots, opts.depressions, opts.region) : buildStops(opts.hotspots, opts.depressions);
  let running = false;
  let idx = 0;
  let token = 0;
  let userPaused = false;
  let hoverPaused = false;
  let arrived = false;
  let elapsed = 0;
  let lastT = 0;
  let raf = 0;
  let card: HTMLElement | null = null;
  let vignette: HTMLElement | null = null;
  let marker: maplibregl.Marker | null = null;
  /** where keyboard focus was before the tour took over; it goes back there at the end */
  let returnFocus: HTMLElement | null = null;

  const paused = () => userPaused || hoverPaused;

  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === ' ' && t?.closest('button, a')) return; // Space presses the focused button instead
    if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') prev();
    else if (e.key === 'Escape') stop();
    else if (e.key === ' ') (userPaused ? resume() : pause());
    else return;
    e.preventDefault();
  };
  // a real user drag/zoom during the tour pauses it (programmatic moves have no originalEvent)
  const onUserMove = (e: { originalEvent?: unknown }) => {
    if (running && e.originalEvent) pause();
  };

  function buildCard() {
    card = document.createElement('section');
    card.className = 'tour-card';
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', 'Guided flood tour');
    card.innerHTML = `
      <div class="tour-timer"><i></i></div>
      <div class="tour-body" aria-live="polite"></div>
      <div class="tour-ctrl">
        <div class="tour-dots" role="group" aria-label="Tour stops">
          ${stops.map((s, i) => `<button type="button" data-i="${i}" aria-label="Stop ${i + 1}: ${esc(s.title)}"><i></i></button>`).join('')}
        </div>
        <div class="tour-btns">
          <button type="button" class="tour-b" data-a="prev" aria-label="Previous stop (Left arrow)" aria-keyshortcuts="ArrowLeft">${iconSvg('chevron', 16, 1.8)}</button>
          <button type="button" class="tour-b" data-a="play" aria-label="Pause (Space)" aria-keyshortcuts="Space"></button>
          <button type="button" class="tour-b" data-a="next" aria-label="Next stop (Right arrow)" aria-keyshortcuts="ArrowRight">${iconSvg('chevron', 16, 1.8)}</button>
          <button type="button" class="tour-b" data-a="close" aria-label="End tour (Esc)" aria-keyshortcuts="Escape">${iconSvg('close', 15, 1.8)}</button>
        </div>
      </div>`;
    card.addEventListener('mouseenter', () => {
      hoverPaused = true;
      syncPause();
    });
    card.addEventListener('mouseleave', () => {
      hoverPaused = false;
      syncPause();
    });
    card.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.i) goTo(Number(b.dataset.i));
      else if (b.dataset.a === 'prev') prev();
      else if (b.dataset.a === 'next') next();
      else if (b.dataset.a === 'close') stop();
      else if (b.dataset.a === 'play') (userPaused ? resume() : pause());
    });
    document.body.appendChild(card);
    vignette = document.createElement('div');
    vignette.className = 'tour-vignette';
    document.body.appendChild(vignette);
    requestAnimationFrame(() => {
      card?.classList.add('in');
      vignette?.classList.add('in');
    });
  }

  function renderCard(s: Stop) {
    if (!card) return;
    const body = card.querySelector('.tour-body') as HTMLElement;
    const depth = s.probe ? probeDepth(opts.getModelDepthAt, s.probe) : undefined;
    const facts = s.facts?.length
      ? `<dl class="tour-facts">${s.facts.map((f) => `<div><dt>${esc(f.l)}</dt><dd>${esc(f.v)}</dd></div>`).join('')}</dl>`
      : '';
    const model =
      depth !== undefined
        ? `<p class="tour-line model">${iconSvg('flood', 15)}<span>Deepest street water the model shows within 300 m: <b>${esc(fmtModelDepth(depth))}</b></span></p>`
        : '';
    const rep = s.reported
      ? `<p class="tour-line rep">${iconSvg('alert', 15)}<span>Reported: <b>${esc(fmtEventDate(s.reported.date))}</b> — ${esc(s.reported.summary)}${
          s.reported.source && s.reported.source !== s.source?.href ? ` <a href="${esc(s.reported.source)}" target="_blank" rel="noopener">Source</a>` : ''
        }</span></p>`
      : '';
    const src = s.source ? `<a class="tour-src" href="${esc(s.source.href)}" target="_blank" rel="noopener">${esc(s.source.label)} ${iconSvg('chevron', 11, 2)}</a>` : '';
    body.dataset.kind = s.kind;
    body.innerHTML = `
      <div class="tour-kick"><span class="tour-num">${String(idx + 1).padStart(2, '0')}<small>/${String(stops.length).padStart(2, '0')}</small></span><span class="tour-kt">${esc(s.kicker)}</span></div>
      <h2 class="tour-title">${esc(s.title)}</h2>
      <p class="tour-text">${esc(s.text)}</p>
      ${facts}${model}${rep}${src}`;
    body.classList.remove('swap');
    void body.offsetWidth;
    body.classList.add('swap');
    card.querySelectorAll<HTMLButtonElement>('.tour-dots button').forEach((b, i) => {
      b.classList.toggle('on', i === idx);
      b.classList.toggle('done', i < idx);
      if (i === idx) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
    });
    syncPause();
  }

  function syncPause() {
    if (!card) return;
    const p = paused();
    card.classList.toggle('paused', p);
    const btn = card.querySelector('[data-a="play"]') as HTMLButtonElement;
    btn.innerHTML = iconSvg(userPaused ? 'play' : 'pause', 14, 1.6);
    btn.setAttribute('aria-label', userPaused ? 'Resume (Space)' : 'Pause (Space)');
  }

  function setMarker(s: Stop) {
    marker?.remove();
    marker = null;
    if (s.kind === 'intro') return;
    const el = document.createElement('div');
    el.className = `tour-pin ${s.kind}`;
    el.innerHTML = '<i></i><i></i><b></b>';
    marker = new maplibregl.Marker({ element: el }).setLngLat(s.probe ?? s.center).addTo(map);
  }

  function cameraOffset(): [number, number] {
    // keep the subject clear of the lower-left caption card
    const w = map.getContainer().clientWidth;
    return w > 900 ? [Math.min(200, w * 0.12), -70] : [0, -110];
  }



  function show(i: number) {
    idx = Math.max(0, Math.min(stops.length - 1, i));
    const s = stops[idx];
    const my = ++token;
    arrived = false;
    elapsed = 0;
    renderCard(s);
    setMarker(s);
    opts.onStep?.(idx);
    // the app's panels hide during the tour, so frame against the whole screen
    const cam = { center: s.center, zoom: s.zoom, pitch: s.pitch, bearing: s.bearing, offset: cameraOffset(), padding: { top: 0, bottom: 0, left: 0, right: 0 } };
    map.stop();
    const arrive = () => {
      if (my !== token || !running) return;
      arrived = true;
      lastT = performance.now();
    };
    if (reducedMotion()) {
      const { offset: [ox, oy], ...jump } = cam;
      map.jumpTo(jump);
      // jumpTo has no offset: nudge so the subject clears the card
      if (ox || oy) {
        const { clientWidth: w, clientHeight: h } = map.getContainer();
        map.jumpTo({ center: map.unproject([w / 2 - ox, h / 2 - oy]) });
      }
      arrive();
    } else {
      const dur = idx === 0 ? 3200 : 5200;
      map.once('moveend', () => settle(map, 1500).then(arrive));
      map.flyTo({ ...cam, duration: dur, curve: 1.25, speed: 0.6, essential: true });
    }
  }

  function loop(t: number) {
    raf = requestAnimationFrame(loop);
    if (!running || !card) return;
    const dt = t - lastT;
    lastT = t;
    const s = stops[idx];
    if (arrived && !paused()) {
      elapsed += dt;
      // slow documentary drift. Per-frame jumps (not one long easeTo) so MapLibre keeps
      // re-sampling terrain elevation under the camera.
      if (!reducedMotion() && !map.isMoving()) map.setBearing(map.getBearing() + (s.drift * Math.min(dt, 64)) / s.dwellMs);
    }
    const p = Math.min(1, elapsed / s.dwellMs);
    card.style.setProperty('--p', String(p));
    if (arrived && p >= 1) {
      if (idx < stops.length - 1) show(idx + 1);
      else stop();
    }
  }

  function start(at = 0): void {
    if (!stops.length) return;
    if (running) return goTo(at);
    orbit(map, false);
    running = true;
    userPaused = hoverPaused = false;
    document.body.classList.add('tour-on');
    buildCard();
    window.addEventListener('keydown', onKey);
    map.on('dragstart', onUserMove);
    map.on('zoomstart', onUserMove);
    map.on('rotatestart', onUserMove);
    map.on('pitchstart', onUserMove);
    lastT = performance.now();
    raf = requestAnimationFrame(loop);
    show(at);
    // the panels hide during the tour: keep keyboard focus on the tour's own controls
    returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    card?.querySelector<HTMLElement>('[data-a="play"]')?.focus({ preventScroll: true });
  }

  function stop() {
    if (!running) return;
    running = false;
    token++;
    cancelAnimationFrame(raf);
    map.stop();
    marker?.remove();
    marker = null;
    window.removeEventListener('keydown', onKey);
    map.off('dragstart', onUserMove);
    map.off('zoomstart', onUserMove);
    map.off('rotatestart', onUserMove);
    map.off('pitchstart', onUserMove);
    document.body.classList.remove('tour-on');
    const c = card;
    const v = vignette;
    card = vignette = null;
    if (c?.contains(document.activeElement) && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
    c?.classList.remove('in');
    v?.classList.remove('in');
    setTimeout(() => {
      c?.remove();
      v?.remove();
    }, reducedMotion() ? 0 : 350);
    opts.onEnd?.();
  }

  function goTo(i: number): void {
    if (!running) return start(i);
    show(i);
  }
  function next() {
    if (!running) return;
    if (idx >= stops.length - 1) stop();
    else show(idx + 1);
  }
  function prev() {
    if (running && idx > 0) show(idx - 1);
  }
  function pause() {
    userPaused = true;
    syncPause();
  }
  function resume() {
    userPaused = false;
    lastT = performance.now();
    syncPause();
  }

  return {
    start,
    stop,
    next,
    prev,
    goTo,
    pause,
    resume,
    get isRunning() {
      return running;
    },
    get index() {
      return idx;
    },
    get length() {
      return stops.length;
    },
  };
}

// ---------- attract mode ----------
const orbits = new WeakMap<MLMap, () => void>();

/**
 * Idle "attract mode": slowly rotate the camera around the current centre.
 * Stops by itself on any pointer/wheel/key input on the map. No-op under prefers-reduced-motion.
 */
export function orbit(map: MLMap, on: boolean, degPerSec = 2.2): void {
  orbits.get(map)?.();
  orbits.delete(map);
  if (!on || reducedMotion()) return;
  let raf = 0;
  let last = performance.now();
  const el = map.getCanvasContainer();
  const tick = (t: number) => {
    const dt = Math.min(64, t - last);
    last = t;
    if (!map.isMoving()) map.setBearing(map.getBearing() + (degPerSec * dt) / 1000);
    raf = requestAnimationFrame(tick);
  };
  const off = () => {
    cancelAnimationFrame(raf);
    el.removeEventListener('pointerdown', off);
    el.removeEventListener('wheel', off);
    el.removeEventListener('keydown', off);
    el.removeEventListener('touchstart', off);
    orbits.delete(map);
  };
  el.addEventListener('pointerdown', off);
  el.addEventListener('wheel', off, { passive: true });
  el.addEventListener('keydown', off);
  el.addEventListener('touchstart', off, { passive: true });
  orbits.set(map, off);
  raf = requestAnimationFrame(tick);
}

export function isOrbiting(map: MLMap): boolean {
  return orbits.has(map);
}
