// "Your place": pin your street or a landmark and get a personal answer:
// will it flood, when, and can I get out (on foot / two-wheeler / car)?
// Everything runs offline on the pincode's pack (no geocoder): see src/place/search.ts and route.ts.
import type { Map as MLMap, MapMouseEvent } from 'maplibre-gl';
import type { Depression, Hotspot, Terrain } from '../types';
import type { OsmFC } from './api';
import type { FloodEngine } from '../sim/index';
import { THRESHOLDS } from '../impact';
import { RouteLayer } from '../map/routeLayer';
import { cellAt, inBBox, maxAround } from '../place/geo';
import { buildSearchIndex, type PlaceKind, type SearchIndex, type SearchResult } from '../place/search';
import {
  buildRoadGraph,
  MODES,
  nearest,
  reachable,
  roadNameAt,
  route,
  WET_M,
  type LngLat,
  type NearestTarget,
  type RoadGraph,
  type RouteResult,
  type TravelMode,
} from '../place/route';
import { RouteSpotsLayer } from '../map/newsLayer';
import { loadNewsSpots } from '../commute/data';
import { spotsNearRoute } from '../commute/near';
import type { NewsSpot } from '../commute/spots';
import {
  commuteSearch,
  fmtHHMM,
  nextCommute,
  nextWeekdayAt,
  parseCommuteLink,
  parseHHMM,
  rainAround,
  rainSpell,
  spotVerdict,
  STALL_M,
  suggestion,
  tripVerdict,
  VERDICT_TEXT,
  type Verdict,
} from '../commute/verdict';
import './place.css';

export interface PlaceOptions {
  map: MLMap;
  terrain: Terrain;
  osm: OsmFC;
  engine: FloodEngine;
  getHour(): number;
  getTimes(): number[];
  /** rain per hour of the run (mm), for the commute check's departure window */
  getRain?(): number[];
  /** fly the camera to a chosen search result (default: map.flyTo) */
  onFocus?(coord: [number, number]): void;
  /** optional: richer search (modelled low spots, reported floods); fetched from /data if omitted */
  depressions?: Depression[];
  hotspots?: Hotspot[];
  /** optional: a place was pinned or cleared (e.g. to expand the sidebar section) */
  onChange?(place: { label: string; coord: [number, number] } | null): void;
}

export interface PlaceHandle {
  setHour(h: number): void;
  /** call after every simulation run */
  refresh(): void;
  destroy(): void;
  pin(coord: [number, number], label?: string): void;
  unpin(): void;
}

/** "water at my door": max depth within this radius of the pin (smoothed ~30 m DEM) */
const NEAR_M = 30;
const STORE_KEY = 'rrnagar-flood:place:v1';
/** one saved place per pincode (560098 keeps the original key); set by mountPlace */
let storeKey = STORE_KEY;
let pinLabel = '560098';
const TZ = 'Asia/Kolkata';
const BIKE = THRESHOLDS.twoWheeler;
const CAR = THRESHOLDS.car;
const SEVERE = THRESHOLDS.severe;

// ------------------------------------------------------------------ icons (rounded 24px strokes)
const ICONS: Record<string, string> = {
  search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m20 20-4.6-4.6"/>',
  clear: '<circle cx="12" cy="12" r="9.5" fill="currentColor" stroke="none"/><path d="m9 9 6 6m0-6-6 6" stroke="#1c1c1e" stroke-width="2"/>',
  pick: '<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
  home: '<path d="M4 10.5 12 4l8 6.5"/><path d="M6.5 9v10.5h11V9"/><path d="M10 19.5v-5h4v5"/>',
  pin: '<path d="M12 21s-6.5-5.5-6.5-11a6.5 6.5 0 0 1 13 0c0 5.5-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
  close: '<path d="m7 7 10 10M17 7 7 17"/>',
  road: '<path d="M8.5 3.5 5.5 20.5M15.5 3.5l3 17M12 5v2.5M12 10.75v2.5M12 16.5V19"/>',
  metro: '<rect x="6" y="3.5" width="12" height="13" rx="3.2"/><path d="M6 10.5h12M9.5 13.8h.01M14.5 13.8h.01M9 20.5l1.5-3.5M15 20.5 13.5 17"/>',
  hospital: '<rect x="4" y="4" width="16" height="16" rx="4.5"/><path d="M12 8.5v7M8.5 12h7"/>',
  clinic: '<path d="M12 20s-7-4.3-7-9.6A4 4 0 0 1 12 8a4 4 0 0 1 7 2.4C19 15.7 12 20 12 20Z"/><path d="M12 11v4M10 13h4"/>',
  school: '<path d="M3 9.5 12 5l9 4.5-9 4.5-9-4.5Z"/><path d="M7 11.6V16c0 1.2 2.2 2.5 5 2.5s5-1.3 5-2.5v-4.4"/>',
  bus: '<rect x="5.5" y="4" width="13" height="13" rx="3"/><path d="M5.5 11h13M9 14.3h.01M15 14.3h.01M8 17v2.5M16 17v2.5"/>',
  market: '<path d="M4.5 9.5 6 4.5h12l1.5 5"/><path d="M4.5 9.5a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0"/><path d="M6 12.5v7h12v-7"/>',
  park: '<path d="M12 21v-5.5"/><path d="M12 15.5c-3.4 0-5.7-2-5.7-5C6.3 7.2 8.8 3.5 12 3.5s5.7 3.7 5.7 7c0 3-2.3 5-5.7 5Z"/>',
  shield: '<path d="M12 3.5 5.5 6v5c0 4.3 2.8 7.8 6.5 9.5 3.7-1.7 6.5-5.2 6.5-9.5V6L12 3.5Z"/>',
  flame: '<path d="M12 21c3.8 0 6.3-2.5 6.3-6 0-3.3-2.4-5.3-3.6-8.3-.9 1.8-1.9 2.6-3 3-.3-2.6-1.3-4.6-3.2-6.3.2 3.2-2.8 5.5-2.8 10.1C5.7 18.5 8.2 21 12 21Z"/>',
  bolt: '<path d="M13 3 6 13h5l-1 8 7-10h-5l1-8Z"/>',
  worship: '<path d="M12 3v3M10.5 4.5h3"/><path d="M6 20.5V13l6-5 6 5v7.5"/><path d="M10 20.5v-3.5a2 2 0 0 1 4 0v3.5"/>',
  drop: '<path d="M12 3.5s6 6.3 6 10.5a6 6 0 0 1-12 0c0-4.2 6-10.5 6-10.5Z"/>',
  basin: '<path d="M3.5 8c2 6.5 4.8 9.5 8.5 9.5S18.5 14.5 20.5 8"/><path d="M8 12.5c1.3.8 2.6 1.2 4 1.2s2.7-.4 4-1.2"/>',
  alert: '<path d="M12 4.5 3.2 19.5h17.6L12 4.5Z"/><path d="M12 10v4.2M12 17h.01"/>',
  flag: '<path d="M6 21V4"/><path d="M6 4.5h11l-2.4 4 2.4 4H6"/>',
  check: '<path d="m6.5 12.5 3.6 3.6 7.4-8.2"/>',
  bang: '<path d="M12 6.5v7M12 17.5v.01"/>',
  wave: '<path d="M4 11c1.6 0 1.6 1.4 3.2 1.4S8.8 11 10.4 11s1.6 1.4 3.2 1.4S15.2 11 16.8 11s1.6 1.4 3.2 1.4"/>',
  dots: '<path d="M7 12h.01M12 12h.01M17 12h.01"/>',
};
function ico(name: string, size = 16, sw = 1.9): string {
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ICONS.pin}</svg>`;
}

const KIND_STYLE: Partial<Record<PlaceKind | 'pin', [string, string]>> = {
  road: ['road', '#7c7c84'],
  metro: ['metro', '#a550e0'],
  hospital: ['hospital', '#e8443a'],
  clinic: ['clinic', '#e0365b'],
  school: ['school', '#e48a0a'],
  bus_stop: ['bus', '#2a93c9'],
  market: ['market', '#d9871c'],
  park: ['park', '#28a745'],
  police: ['shield', '#0a6fd8'],
  fire_station: ['flame', '#e2552a'],
  substation: ['bolt', '#c69a06'],
  worship: ['worship', '#5856d6'],
  water: ['drop', '#1f86c7'],
  lowspot: ['basin', '#2f7fb5'],
  hotspot: ['alert', '#e8701a'],
  coord: ['pin', '#7c7c84'],
  pin: ['pin', '#0a84ff'],
};
const badge = (kind: string, size = 15) => {
  const [icon, color] = KIND_STYLE[kind as PlaceKind] ?? KIND_STYLE.pin!;
  return `<span class="pl-badge" style="--c:${color}">${ico(icon, size, 2)}</span>`;
};

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ------------------------------------------------------------------ formatting
const cm = (m: number) => (m >= 1 ? `${m.toFixed(1)} m` : `${Math.round(m * 100)} cm`);
const dist = (m: number) => (m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`);
function mins(m: number): string {
  const r = Math.max(1, Math.round(m));
  return r < 60 ? `${r} min` : `${Math.floor(r / 60)} h ${String(r % 60).padStart(2, '0')} min`;
}
function makeWhen(times: number[]) {
  const ok = times.length > 0 && times.every(Number.isFinite);
  const dayKey = (t: number) => new Date(t).toLocaleDateString('en-GB', { timeZone: TZ });
  const multi = ok && dayKey(times[0]) !== dayKey(times[times.length - 1]);
  const hm = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
  const wd = (t: number) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', timeZone: TZ });
  const has = (i: number) => ok && times[i] !== undefined;
  const at = (i: number) => (has(i) ? (multi ? `${wd(times[i])} ${hm(times[i])}` : hm(times[i])) : `hour ${i}`);
  return {
    /** "03:00", or "Mon 03:00" when the run spans several days */
    at,
    /** always with the weekday */
    full: (i: number) => (has(i) ? `${wd(times[i])} ${hm(times[i])}` : `hour ${i}`),
    /** clock time only */
    hm: (i: number) => (has(i) ? hm(times[i]) : `hour ${i}`),
    /** time j written relative to time i: drops the weekday when both fall on the same day */
    after: (i: number, j: number) => (has(i) && has(j) && dayKey(times[i]) === dayKey(times[j]) ? hm(times[j]) : at(j)),
  };
}
type When = ReturnType<typeof makeWhen>;

/** contiguous runs of hours above thr (gaps of one hour are bridged) */
function spells(d: Float32Array, n: number, thr: number): { s: number; e: number }[] {
  const out: { s: number; e: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (!(d[i] > thr)) continue;
    const last = out[out.length - 1];
    if (last && i - last.e <= 2) last.e = i;
    else out.push({ s: i, e: i });
  }
  return out;
}

type Sev = 'idle' | 'ok' | 'info' | 'warn' | 'danger';
const SEV_ICON: Record<Sev, string> = { idle: 'dots', ok: 'check', info: 'wave', warn: 'bang', danger: 'bang' };

/** Plain-language answer for "will my street flood, and when?" — the answer first, then the detail. */
function verdictFor(d: Float32Array, n: number, w: When): { lead: string; detail: string; sev: Sev } {
  let peak = 0, ph = 0;
  for (let i = 0; i < n; i++)
    if (d[i] > peak) {
      peak = d[i];
      ph = i;
    }
  if (peak < WET_M) return { lead: 'Your street stays dry.', detail: `Less than ${cm(WET_M)} of water within ${NEAR_M} m at every hour of this run.`, sev: 'ok' };
  if (peak <= BIKE)
    return { lead: 'Puddles only: your street stays passable.', detail: `Up to ${cm(peak)} around ${w.at(ph)}. Walking, two-wheelers and cars all get through.`, sev: 'info' };
  // "from Mon 02:00 to 06:00" for a spell above a threshold; `ref` drops a repeated weekday
  const window = (sp: { s: number; e: number }, ref = -1) => {
    const end = sp.e + 1 < n ? sp.e + 1 : -1;
    const from = ref >= 0 ? w.after(ref, sp.s) : w.at(sp.s);
    const until = end >= 0 ? w.after(sp.s, end) : '';
    return { from, until, text: until ? `from ${from} to ${until}` : `from ${from} until the end of this run` };
  };
  const bike = spells(d, n, BIKE);
  const b = window(bike[0]);
  const advice = b.until ? `Leave before ${b.from} or wait until ${b.until}.` : `Leave before ${b.from}.`;
  const more = bike.length > 1 ? ` It happens ${bike.length} times in this run; the first is shown.` : '';
  const peakAt = `Peak ${cm(peak)} at ${w.at(ph)}`;
  if (peak <= CAR) return { lead: `Two-wheelers stall on your street ${b.text}. ${advice}`, detail: `${peakAt}. Cars and people on foot still get through, slowly.${more}`, sev: 'warn' };
  const carText = window(spells(d, n, CAR)[0], bike[0].s).text;
  if (peak <= SEVERE)
    return {
      lead: `Two-wheelers stall on your street ${b.text}, cars ${carText}. ${advice}`,
      detail: `${peakAt}: too deep to wade safely, and enough to wet ground floors.${more}`,
      sev: 'danger',
    };
  return {
    lead: `Deep water: ${cm(peak)} at ${w.at(ph)}. Stay off your street ${b.text}.`,
    detail: `Cars stall ${carText}. Ground floors take water: move vehicles and valuables up before ${b.from}.${more}`,
    sev: 'danger',
  };
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ------------------------------------------------------------------ storage (optional)
interface Saved {
  place?: { coord: LngLat; label: string; sub: string; kind: string };
  mode?: TravelMode;
  dest?: NearestTarget | 'custom' | null;
  custom?: { coord: LngLat; label: string };
}
function load(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(storeKey) ?? 'null');
    return s && typeof s === 'object' ? (s as Saved) : {};
  } catch {
    return {};
  }
}
function store(s: Saved) {
  try {
    localStorage.setItem(storeKey, JSON.stringify(s));
  } catch {
    /* private mode / blocked storage: the panel works without it */
  }
}

const idle = (fn: () => void) => {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 2500 });
  else setTimeout(fn, 400);
};

let uidSeq = 0;
const DEST_NOUN: Record<NearestTarget, string> = { metro: 'metro station', hospital: 'hospital', bus_stop: 'bus stop', main_road: 'main road' };

// ------------------------------------------------------------------ mount
export function mountPlace(container: HTMLElement, opts: PlaceOptions): PlaceHandle {
  pinLabel = opts.terrain.meta.pincode;
  storeKey = pinLabel === '560098' ? STORE_KEY : `${STORE_KEY}:${pinLabel}`;
  const { map, terrain, osm, engine } = opts;
  const meta = terrain.meta;
  const uid = `pl${++uidSeq}`;
  const layer = new RouteLayer(map);

  // ---- lazy data structures
  let graph: RoadGraph | null = null;
  const G = () => (graph ??= buildRoadGraph(osm, meta));
  const extras: { depressions?: Depression[]; hotspots?: Hotspot[] } = { depressions: opts.depressions, hotspots: opts.hotspots };
  let index: SearchIndex | null = null;
  const I = () => (index ??= buildSearchIndex(osm, meta, extras));

  // ---- state
  const saved = load();
  let place: { coord: LngLat; label: string; sub: string; kind: string; cell: number; labelFixed: boolean } | null = null;
  let mode: TravelMode = saved.mode && saved.mode in MODES ? saved.mode : 'two_wheeler';
  let dest: NearestTarget | 'custom' | null = saved.dest === undefined ? 'main_road' : saved.dest;
  let custom: { coord: LngLat; label: string } | null = saved.custom && Array.isArray(saved.custom.coord) ? saved.custom : null;
  if (dest === 'custom' && !custom) dest = null;
  let picking: 'place' | 'dest' | null = null;
  let hour = opts.getHour();
  let series: Float32Array | null = null;
  let seriesN = 0;
  let seriesJob = 0;
  let last: { r: RouteResult | null; target: string; usualTarget?: string; hour: number } | null = null;
  let reopen: { state: 'idle' | 'scan' | 'found' | 'none'; hour?: number; alt?: TravelMode[] } = { state: 'idle' };
  let scanJob = 0;
  let routeTimer = 0;
  let lastRouteAt = 0;
  let results: SearchResult[] = [];
  let active = -1;

  // ---- DOM
  container.innerHTML = `
  <div class="pl">
    <div class="pl-search">
      <div class="pl-field">
        <span class="pl-glass-ico">${ico('search', 16, 2.1)}</span>
        <label class="pl-sr" for="${uid}-q">Find your street or a landmark</label>
        <input id="${uid}-q" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${uid}-list"
          autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" placeholder="Street, landmark or lat, lng" />
        <button type="button" class="pl-clear" aria-label="Clear search" hidden>${ico('clear', 17, 0)}</button>
      </div>
      <button type="button" class="pl-iconbtn" data-act="pick" aria-pressed="false" aria-label="Pick a spot on the map" title="Pick on the map (or right-click / long-press it)">${ico('pick', 19, 2)}</button>
      <ul class="pl-list" id="${uid}-list" role="listbox" aria-label="Matching places" hidden></ul>
    </div>
    <p class="pl-picking" role="status" hidden></p>
    <p class="pl-hint">Find your street to see whether it floods, when, and whether you can get out. You can also <b>right-click</b> or <b>long-press</b> the map.</p>
    <section class="pl-card" aria-labelledby="${uid}-name" hidden>
      <div class="pl-head">
        <span class="pl-badge" aria-hidden="true">${ico('home', 17, 2.1)}</span>
        <div class="pl-name"><b id="${uid}-name"></b><small></small></div>
        <button type="button" class="pl-x" aria-label="Unpin this place" title="Unpin">${ico('close', 13, 2.6)}</button>
      </div>
      <div class="pl-verdict" data-sev="idle" aria-live="polite"><span class="pl-dot" aria-hidden="true"></span><div><p class="pl-lead"></p><p class="pl-detail"></p></div></div>
      <div class="pl-stats">
        <div class="pl-stat" data-k="now" title="Water within 30 m of this spot at the selected hour"><span>Water now</span><b></b><small></small></div>
        <div class="pl-stat" data-k="peak"><span>Peak</span><b></b><small></small></div>
        <div class="pl-stat" data-k="above" title="Hours with more than 15 cm of water: two-wheelers stall"><span>Over 15 cm</span><b></b><small></small></div>
      </div>
      <figure class="pl-spark"><div class="pl-spark-svg"></div><figcaption><span></span><span></span></figcaption></figure>
    </section>
    <section class="pl-out" aria-labelledby="${uid}-out" hidden>
      <h3 id="${uid}-out">Can I get out?</h3>
      <div class="pl-seg" role="radiogroup" aria-label="Travel mode">
        <span class="pl-seg-thumb" aria-hidden="true"></span>
        <button type="button" role="radio" data-mode="walk">Walk</button>
        <button type="button" role="radio" data-mode="two_wheeler">Two-wheeler</button>
        <button type="button" role="radio" data-mode="car">Car</button>
      </div>
      <div class="pl-dests">
        <button type="button" class="pl-cap" data-dest="metro" aria-pressed="false">${ico('metro', 15, 2)}<span>Nearest metro</span></button>
        <button type="button" class="pl-cap" data-dest="hospital" aria-pressed="false">${ico('hospital', 15, 2)}<span>Nearest hospital</span></button>
        <button type="button" class="pl-cap" data-dest="main_road" aria-pressed="false">${ico('road', 15, 2)}<span>Main road</span></button>
        <button type="button" class="pl-cap" data-dest="custom" aria-pressed="false">${ico('flag', 15, 2)}<span>Pick destination</span></button>
      </div>
      <div class="pl-ans" data-state="idle" aria-live="polite"><span class="pl-dot" aria-hidden="true"></span><div><p class="pl-lead"></p><p class="pl-detail"></p><p class="pl-detail pl-extra"></p></div></div>
      <ul class="pl-legend" aria-label="Route colours" hidden>
        <li><i style="--c:#2fe0d0"></i>Dry</li><li><i style="--c:#ffb02e"></i>Wet, passable</li><li><i style="--c:#ff3b4f"></i>Too deep</li><li class="pl-lg-usual"><i class="dash"></i>Usual route</li>
      </ul>
      <div class="pl-commute" hidden>
        <h3 id="${uid}-cm">Commute check</h3>
        <div class="pl-dep">
          <div class="pl-seg pl-seg-dep" role="radiogroup" aria-label="Departure">
            <span class="pl-seg-thumb" aria-hidden="true"></span>
            <button type="button" role="radio" data-slot="am">Morning</button>
            <button type="button" role="radio" data-slot="pm">Evening</button>
          </div>
          <label class="pl-time"><span class="pl-sr">Leave at</span><input type="time" step="900" aria-label="Leave at" /></label>
        </div>
        <div class="pl-ans pl-cv" data-state="idle" aria-live="polite"><span class="pl-dot" aria-hidden="true"></span><div><p class="pl-lead"></p><p class="pl-detail"></p><p class="pl-detail pl-extra"></p></div></div>
        <p class="pl-spots-h"></p>
        <ul class="pl-spots" aria-labelledby="${uid}-cm"></ul>
        <button type="button" class="pl-share btn-link">Copy link to this commute</button>
      </div>
    </section>
  </div>`;
  const root = container.firstElementChild as HTMLElement;
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const input = $<HTMLInputElement>('input');
  const clearBtn = $<HTMLButtonElement>('.pl-clear');
  const pickBtn = $<HTMLButtonElement>('[data-act="pick"]');
  const list = $<HTMLUListElement>('.pl-list');
  const pickingEl = $('.pl-picking');
  const hint = $('.pl-hint');
  const card = $('.pl-card');
  const out = $('.pl-out');
  const seg = $('.pl-seg');
  const legend = $('.pl-legend');

  // ------------------------------------------------------------------ search box
  function highlight(label: string, q: string): string {
    const toks = q.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length > 0);
    return label
      .split(/(\s+)/)
      .map((word) => {
        const lw = word.toLowerCase();
        const t = toks.find((x) => lw.startsWith(x));
        return t ? `<mark>${esc(word.slice(0, t.length))}</mark>${esc(word.slice(t.length))}` : esc(word);
      })
      .join('');
  }
  function renderList() {
    const q = input.value.trim();
    if (!q) {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      return;
    }
    if (!results.length) {
      list.innerHTML = `<li class="pl-empty" role="presentation">No match in the map data. Try a road, a landmark, or “12.92, 77.51”.</li>`;
    } else {
      list.innerHTML = results
        .map(
          (r, i) =>
            `<li class="pl-opt" role="option" id="${uid}-o${i}" data-i="${i}" aria-selected="${i === active}">${badge(r.kind)}<span class="pl-opt-t"><b>${highlight(r.label, q)}</b><small>${esc(r.sublabel)}</small></span></li>`,
        )
        .join('');
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `${uid}-o${active}`);
    else input.removeAttribute('aria-activedescendant');
  }
  function closeList() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }
  function choose(r: SearchResult) {
    closeList();
    input.value = '';
    clearBtn.hidden = true;
    results = [];
    if (r.kind === 'coord' && !inBBox(meta, r.coord)) {
      flash(`That point is outside the modelled area around ${pinLabel}.`);
      return;
    }
    pinAt(r.coord, { label: r.label, sub: r.sublabel, kind: r.kind });
    input.blur();
    if (opts.onFocus) opts.onFocus(r.coord);
    else map.flyTo({ center: r.coord, zoom: Math.max(map.getZoom(), 16.2), essential: true });
  }
  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearBtn.hidden = !input.value;
    results = q ? I().search(q, 7) : [];
    active = results.length ? 0 : -1;
    renderList();
  });
  input.addEventListener('focus', () => {
    I();
    if (input.value.trim()) renderList();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      const n = results.length;
      active = e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n;
      renderList();
      root.querySelector(`#${uid}-o${active}`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[active >= 0 ? active : 0];
      if (r) choose(r);
    } else if (e.key === 'Escape') {
      if (!list.hidden) {
        e.preventDefault();
        closeList();
      } else if (input.value) {
        e.preventDefault();
        input.value = '';
        clearBtn.hidden = true;
      } else if (picking) {
        e.preventDefault();
        stopPicking();
      }
    }
  });
  list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
  list.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('.pl-opt');
    if (li) choose(results[Number(li.dataset.i)]);
  });
  list.addEventListener('mousemove', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('.pl-opt');
    const i = li ? Number(li.dataset.i) : -1;
    if (i >= 0 && i !== active) {
      active = i;
      for (const o of list.querySelectorAll('.pl-opt')) o.setAttribute('aria-selected', String(o === li));
      input.setAttribute('aria-activedescendant', `${uid}-o${i}`);
    }
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.hidden = true;
    results = [];
    closeList();
    input.focus();
  });
  const onDocDown = (e: PointerEvent) => {
    if (!root.querySelector('.pl-search')!.contains(e.target as Node)) closeList();
  };
  document.addEventListener('pointerdown', onDocDown);

  let flashTimer = 0;
  function flash(msg: string) {
    pickingEl.textContent = msg;
    pickingEl.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      if (!picking) pickingEl.hidden = true;
    }, 3500);
  }

  // ------------------------------------------------------------------ picking on the map
  function startPicking(what: 'place' | 'dest') {
    picking = what;
    map.getCanvas().style.cursor = 'crosshair';
    pickBtn.setAttribute('aria-pressed', String(what === 'place'));
    pickingEl.innerHTML = `${ico('pick', 15, 2)}<span>${what === 'place' ? 'Click the map to pin your place' : 'Click the map to set where you need to go'}. <kbd>Esc</kbd> cancels.</span>`;
    pickingEl.hidden = false;
    syncDestButtons();
  }
  function stopPicking() {
    picking = null;
    map.getCanvas().style.cursor = '';
    pickBtn.setAttribute('aria-pressed', 'false');
    pickingEl.hidden = true;
    syncDestButtons();
  }
  pickBtn.addEventListener('click', () => (picking === 'place' ? stopPicking() : startPicking('place')));
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && picking) {
      stopPicking();
      e.stopPropagation();
    }
  };
  document.addEventListener('keydown', onKey, true);

  const onMapClick = (e: MapMouseEvent) => {
    if (!picking) return;
    const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
    const what = picking;
    stopPicking();
    if (what === 'place') pinAt(p);
    else setCustomDest(p);
  };
  map.on('click', onMapClick);

  // right-click (without dragging: right-drag rotates the map) and long-press pin a place
  const canvasBox = map.getCanvasContainer();
  let rDown: { x: number; y: number } | null = null;
  const unprojectClient = (x: number, y: number): LngLat => {
    const r = canvasBox.getBoundingClientRect();
    const ll = map.unproject([x - r.left, y - r.top]);
    return [ll.lng, ll.lat];
  };
  const onMouseDown = (e: MouseEvent) => {
    if (e.button === 2) rDown = { x: e.clientX, y: e.clientY };
  };
  const onMouseUp = (e: MouseEvent) => {
    if (e.button !== 2 || !rDown) return;
    const moved = Math.hypot(e.clientX - rDown.x, e.clientY - rDown.y);
    rDown = null;
    if (moved <= 4) pinAt(unprojectClient(e.clientX, e.clientY));
  };
  const onCtx = (e: Event) => e.preventDefault();
  let lpTimer = 0;
  let lpStart: { x: number; y: number } | null = null;
  const lpCancel = () => {
    clearTimeout(lpTimer);
    lpStart = null;
  };
  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return lpCancel();
    const t = e.touches[0];
    lpStart = { x: t.clientX, y: t.clientY };
    clearTimeout(lpTimer);
    lpTimer = window.setTimeout(() => {
      if (!lpStart) return;
      const p = unprojectClient(lpStart.x, lpStart.y);
      lpStart = null;
      try {
        navigator.vibrate?.(12);
      } catch {
        /* not supported */
      }
      if (picking === 'dest') {
        stopPicking();
        setCustomDest(p);
      } else {
        if (picking) stopPicking();
        pinAt(p);
      }
    }, 550);
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!lpStart) return;
    const t = e.touches[0];
    if (!t || Math.hypot(t.clientX - lpStart.x, t.clientY - lpStart.y) > 10) lpCancel();
  };
  canvasBox.addEventListener('mousedown', onMouseDown);
  canvasBox.addEventListener('mouseup', onMouseUp);
  canvasBox.addEventListener('contextmenu', onCtx);
  canvasBox.addEventListener('touchstart', onTouchStart, { passive: true });
  canvasBox.addEventListener('touchmove', onTouchMove, { passive: true });
  canvasBox.addEventListener('touchend', lpCancel, { passive: true });
  canvasBox.addEventListener('touchcancel', lpCancel, { passive: true });

  // ------------------------------------------------------------------ pin / unpin
  function describePoint(p: LngLat): { label: string; sub: string; kind: string } {
    const idx = I();
    const lm = idx.landmarkNear(p, 35);
    const area = idx.areaOf(p);
    if (lm) return { label: lm.label, sub: lm.sublabel, kind: lm.kind };
    const road = roadNameAt(G(), p, 70);
    if (road) return { label: road.name, sub: ['Street', area].filter(Boolean).join(' · '), kind: 'road' };
    return { label: 'Dropped pin', sub: [area, `${p[1].toFixed(5)}, ${p[0].toFixed(5)}`].filter(Boolean).join(' · '), kind: 'pin' };
  }
  function pinAt(p: LngLat, info?: { label: string; sub: string; kind: string }) {
    if (!inBBox(meta, p)) {
      flash(`That spot is outside the modelled area around ${pinLabel}.`);
      return;
    }
    const d = info ?? describePoint(p);
    place = { coord: p, label: d.label, sub: d.sub, kind: d.kind, cell: cellAt(meta, p[0], p[1]), labelFixed: !!info };
    layer.setPlace(p);
    hint.hidden = true;
    card.hidden = false;
    out.hidden = false;
    reopen = { state: 'idle' };
    last = null;
    save();
    renderHead();
    computeSeries();
    runRoute(false);
    opts.onChange?.({ label: place.label, coord: p });
  }
  function unpin() {
    place = null;
    seriesJob++;
    scanJob++;
    series = null;
    last = null;
    layer.setPlace(null);
    layer.setRoute(null);
    card.hidden = true;
    out.hidden = true;
    legend.hidden = true;
    hint.hidden = false;
    save();
    renderCommute();
    opts.onChange?.(null);
  }
  $('.pl-x').addEventListener('click', unpin);

  function save() {
    store({
      place: place ? { coord: place.coord, label: place.label, sub: place.sub, kind: place.kind } : undefined,
      mode,
      dest,
      custom: custom ?? undefined,
    });
  }

  // ------------------------------------------------------------------ place card
  const hoursN = () => {
    const t = opts.getTimes();
    return Math.min(engine.hours, t.length || engine.hours);
  };
  function renderHead() {
    if (!place) return;
    const elev = place.cell >= 0 ? (terrain.grids.elevation as Float32Array)[place.cell] : NaN;
    $('.pl-head .pl-badge').innerHTML = ico(place.kind === 'road' || place.kind === 'pin' || place.kind === 'coord' ? 'home' : (KIND_STYLE[place.kind as PlaceKind]?.[0] ?? 'home'), 17, 2.1);
    $(`#${uid}-name`).textContent = place.label;
    $('.pl-name small').textContent = [place.sub, Number.isFinite(elev) ? `ground\u00a0${Math.round(elev)}\u00a0m` : ''].filter(Boolean).join(' · ');
  }

  function computeSeries() {
    const job = ++seriesJob;
    series = null;
    seriesN = 0;
    if (!place || place.cell < 0) return renderCard();
    const n = hoursN();
    if (!n) return renderCard();
    const cell = place.cell;
    const outArr = new Float32Array(n);
    let k = 0;
    renderCard();
    const step = () => {
      if (job !== seriesJob) return;
      const t0 = performance.now();
      while (k < n && performance.now() - t0 < 12) {
        const s = engine.snapshot(k);
        outArr[k] = s ? maxAround(s.depth, meta, cell, NEAR_M) : 0;
        k++;
      }
      if (k < n) {
        setTimeout(step, 0);
        return;
      }
      series = outArr;
      seriesN = n;
      renderCard();
    };
    step();
  }

  function depthNow(): number | null {
    if (!place || place.cell < 0) return null;
    if (series && hour < seriesN) return series[Math.max(0, Math.floor(hour))];
    const s = engine.hours ? engine.snapshot(hour) : undefined;
    return s ? maxAround(s.depth, meta, place.cell, NEAR_M) : null;
  }

  function setStat(k: string, val: string, unit = '', sub = '', sev = '') {
    const el = $(`.pl-stat[data-k="${k}"]`);
    el.querySelector('b')!.innerHTML = `${esc(val)}${unit ? `<em>${esc(unit)}</em>` : ''}`;
    el.querySelector('small')!.textContent = sub;
    if (sev) el.dataset.sev = sev;
    else delete el.dataset.sev;
  }
  const sevOf = (d: number): Sev => (d > CAR ? 'danger' : d > BIKE ? 'warn' : d >= WET_M ? 'info' : 'ok');
  const depthParts = (d: number): [string, string] => (d < 0.01 ? ['Dry', ''] : d >= 1 ? [d.toFixed(2), 'm'] : [String(Math.round(d * 100)), 'cm']);

  function setVerdict(sev: Sev, lead: string, detail: string) {
    const v = $('.pl-verdict');
    v.dataset.sev = sev;
    v.querySelector('.pl-dot')!.innerHTML = ico(SEV_ICON[sev], 14, 2.6);
    v.querySelector('.pl-lead')!.textContent = lead;
    v.querySelector('.pl-detail')!.textContent = detail;
  }

  function renderCard() {
    if (!place) return;
    renderHead();
    const n = hoursN();
    const w = makeWhen(opts.getTimes());
    const sparkBox = $('.pl-spark-svg');
    const cap0 = $('.pl-spark figcaption span:first-child');
    const cap1 = $('.pl-spark figcaption span:last-child');
    if (place.cell < 0) {
      setVerdict('idle', 'Outside the modelled area.', `The flood model covers pincode ${pinLabel} and a margin around it.`);
      ['now', 'peak', 'above'].forEach((k) => setStat(k, '–'));
      sparkBox.innerHTML = '';
      return;
    }
    if (!n) {
      setVerdict('idle', 'No flood run yet.', 'Choose the forecast or a storm scenario to see water at this spot.');
      ['now', 'peak', 'above'].forEach((k) => setStat(k, '–'));
      sparkBox.innerHTML = '';
      cap0.textContent = cap1.textContent = '';
      return;
    }
    if (!series) {
      setVerdict('idle', 'Reading water levels…', '');
      sparkBox.innerHTML = '<div class="pl-skel"></div>';
      renderNow();
      return;
    }
    const v = verdictFor(series, seriesN, w);
    setVerdict(v.sev, v.lead, v.detail);
    let peak = 0, ph = 0, above = 0;
    for (let i = 0; i < seriesN; i++) {
      if (series[i] > peak) {
        peak = series[i];
        ph = i;
      }
      if (series[i] > BIKE) above++;
    }
    const [pv, pu] = depthParts(peak);
    setStat('peak', pv, pu, peak >= 0.01 ? w.full(ph) : 'all run', peak >= 0.01 ? sevOf(peak) : '');
    const sp = spells(series, seriesN, BIKE);
    setStat('above', String(above), 'h', above ? `from ${w.hm(sp[0].s)}` : 'never', above ? 'warn' : '');
    cap0.textContent = w.full(0);
    cap1.textContent = w.full(seriesN - 1);
    renderNow();
  }

  function renderNow() {
    if (!place || place.cell < 0 || !hoursN()) return;
    const d = depthNow();
    const w = makeWhen(opts.getTimes());
    if (d === null) setStat('now', '–');
    else {
      const [v, u] = depthParts(d);
      setStat('now', v, u, w.full(Math.floor(hour)), d >= WET_M ? sevOf(d) : '');
    }
    if (series) $('.pl-spark-svg').innerHTML = sparkSvg(series, seriesN, hour);
  }

  function sparkSvg(d: Float32Array, n: number, h: number): string {
    const box = $('.pl-spark-svg');
    const W = Math.max(160, Math.round(box.clientWidth || 260));
    const H = 74, top = 12, bot = H - 3, padX = 3;
    let peak = 0, ph = 0;
    for (let i = 0; i < n; i++) if (d[i] > peak) {
      peak = d[i];
      ph = i;
    }
    const ymax = Math.max(0.36, peak * 1.12);
    const x = (i: number) => padX + (n > 1 ? (i / (n - 1)) * (W - 2 * padX) : 0);
    const y = (v: number) => bot - (Math.min(v, ymax) / ymax) * (bot - top);
    let line = '';
    for (let i = 0; i < n; i++) line += `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(d[i]).toFixed(1)}`;
    const area = `${line}L${x(n - 1).toFixed(1)} ${bot}L${x(0).toFixed(1)} ${bot}Z`;
    const g = `${uid}-g`;
    // stroke: blue/teal while shallow, amber above 15 cm, red above 30 cm
    const off = (v: number) => Math.max(0, Math.min(1, (bot - y(v)) / (bot - top)));
    const tl = (v: number, label: string, color: string) =>
      v <= ymax
        ? `<line x1="${padX}" x2="${W - padX}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${color}" stroke-opacity="0.55" stroke-width="1" stroke-dasharray="2 3"/>` +
          `<text x="${W - padX}" y="${(y(v) - 3).toFixed(1)}" text-anchor="end" fill="${color}" fill-opacity="0.9">${label}</text>`
        : '';
    const hi = Math.max(0, Math.min(n - 1, Math.floor(h)));
    const hx = x(hi), hy = y(d[hi]);
    const px = x(ph), py = y(peak);
    const peakLabel = peak >= 0.05 ? `<text x="${Math.min(Math.max(px, 18), W - 18).toFixed(1)}" y="${Math.max(9, py - 6).toFixed(1)}" text-anchor="middle" fill="rgba(235,235,245,0.75)">${cm(peak)}</text>` : '';
    const label = `Water depth at this spot over the run: peak ${cm(peak)}. The marker shows the current hour, ${cm(d[hi])}.`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="${g}-f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a84ff" stop-opacity="0.42"/><stop offset="1" stop-color="#40c8e0" stop-opacity="0.02"/></linearGradient>
        <linearGradient id="${g}-s" gradientUnits="userSpaceOnUse" x1="0" y1="${bot}" x2="0" y2="${top}">
          <stop offset="0" stop-color="#40c8e0"/><stop offset="${off(BIKE).toFixed(3)}" stop-color="#0a84ff"/>
          <stop offset="${off(BIKE).toFixed(3)}" stop-color="#ff9f0a"/><stop offset="${off(CAR).toFixed(3)}" stop-color="#ff9f0a"/>
          <stop offset="${off(CAR).toFixed(3)}" stop-color="#ff453a"/><stop offset="1" stop-color="#ff453a"/>
        </linearGradient>
      </defs>
      <line x1="${padX}" x2="${W - padX}" y1="${bot}" y2="${bot}" stroke="rgba(235,235,245,0.18)" stroke-width="1"/>
      ${tl(BIKE, '15 cm', '#ff9f0a')}${tl(CAR, '30 cm', '#ff453a')}
      <path d="${area}" fill="url(#${g}-f)"/>
      <path d="${line}" fill="none" stroke="url(#${g}-s)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      ${peakLabel}
      <line x1="${hx.toFixed(1)}" x2="${hx.toFixed(1)}" y1="${top - 6}" y2="${bot}" stroke="rgba(255,255,255,0.55)" stroke-width="1"/>
      <circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="4" fill="#fff" stroke="#0a84ff" stroke-width="2"/>
    </svg>`;
  }

  // ------------------------------------------------------------------ can I get out?
  function syncModes() {
    const btns = [...seg.querySelectorAll<HTMLButtonElement>('button[data-mode]')];
    btns.forEach((b, i) => {
      const on = b.dataset.mode === mode;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on) seg.style.setProperty('--i', String(i));
    });
  }
  function syncDestButtons() {
    for (const b of root.querySelectorAll<HTMLButtonElement>('.pl-cap')) {
      const k = b.dataset.dest;
      b.setAttribute('aria-pressed', String(k === 'custom' ? dest === 'custom' || picking === 'dest' : dest === k));
    }
    const span = root.querySelector('.pl-cap[data-dest="custom"] span')!;
    span.textContent = dest === 'custom' && custom ? custom.label : 'Pick destination';
  }
  seg.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-mode]');
    if (!b) return;
    setMode(b.dataset.mode as TravelMode);
  });
  seg.addEventListener('keydown', (e) => {
    const order: TravelMode[] = ['walk', 'two_wheeler', 'car'];
    const i = order.indexOf(mode);
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % 3;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i + 2) % 3;
    if (j < 0) return;
    e.preventDefault();
    setMode(order[j]);
    seg.querySelector<HTMLButtonElement>(`button[data-mode="${order[j]}"]`)?.focus();
  });
  function setMode(m: TravelMode) {
    if (m === mode) return;
    mode = m;
    syncModes();
    save();
    runRoute(false);
  }
  root.querySelector('.pl-dests')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.pl-cap');
    if (!b) return;
    const k = b.dataset.dest as NearestTarget | 'custom';
    if (k === 'custom') {
      if (picking === 'dest') stopPicking();
      else startPicking('dest');
      return;
    }
    if (picking) stopPicking();
    dest = dest === k ? null : k;
    syncDestButtons();
    save();
    runRoute(true);
  });
  function setCustomDest(p: LngLat) {
    const d = describePoint(p);
    custom = { coord: p, label: d.label === 'Dropped pin' ? 'Pinned destination' : d.label };
    dest = 'custom';
    syncDestButtons();
    save();
    runRoute(true);
  }

  function currentDepth(): Float32Array | null {
    if (!engine.hours) return null;
    return engine.snapshot(Math.min(Math.floor(hour), engine.hours - 1))?.depth ?? null;
  }

  function scheduleRoute() {
    if (!place || !dest) return;
    clearTimeout(routeTimer);
    const since = performance.now() - lastRouteAt;
    // at most ~3 updates a second while the timeline plays; always a trailing update
    routeTimer = window.setTimeout(() => runRoute(false), since > 350 ? 40 : 350 - since);
  }

  function runRoute(fit: boolean) {
    clearTimeout(routeTimer);
    scanJob++;
    lastRouteAt = performance.now();
    reopen = { state: 'idle' };
    if (!place || !dest || (dest === 'custom' && !custom)) {
      last = null;
      layer.setRoute(null);
      legend.hidden = true;
      renderAnswer();
      renderCommute();
      return;
    }
    const g = G();
    const depth = currentDepth();
    let r: RouteResult | null = null;
    let target = '';
    let targetCoord: LngLat | null = null;
    let usualTarget: string | undefined;
    if (dest === 'custom') {
      r = route(g, depth, place.coord, custom!.coord, mode);
      target = custom!.label;
      targetCoord = custom!.coord;
    } else {
      const nr = nearest(g, depth, place.coord, dest, mode, osm);
      if (nr) {
        r = nr.route;
        target = displayTarget(nr.target.name, dest);
        targetCoord = nr.target.coord;
        usualTarget = nr.usualTarget ? displayTarget(nr.usualTarget.name, dest) : undefined;
      }
    }
    last = { r, target, usualTarget, hour };
    layer.setRoute(r && !r.error ? r : null, targetCoord, dest);
    legend.hidden = !(r && r.coords.length);
    (legend.querySelector('.pl-lg-usual') as HTMLElement).hidden = !r?.usual;
    renderAnswer();
    if (fit && r && r.coords.length > 1) layer.fit(r, place.coord);
    if (r && !r.ok && !r.error) startReopenScan();
    renderCommute();
  }
  const displayTarget = (name: string, kind: NearestTarget) => (kind === 'metro' && !/metro/i.test(name) ? `${name} metro station` : name);

  function startReopenScan() {
    const job = ++scanJob;
    const n = hoursN();
    const from = Math.floor(hour);
    const p = place!.coord;
    const to: LngLat | NearestTarget = dest === 'custom' ? custom!.coord : (dest as NearestTarget);
    const m = mode;
    reopen = { state: 'scan' };
    // which other modes still get through right now?
    const depthNow = currentDepth();
    const g = G();
    reopen.alt = (['walk', 'two_wheeler', 'car'] as TravelMode[]).filter((x) => x !== m && reachable(g, depthNow, p, to, x, osm));
    renderAnswer();
    let k = from + 1;
    const step = () => {
      if (job !== scanJob) return;
      const t0 = performance.now();
      while (k < n && performance.now() - t0 < 10) {
        const s = engine.snapshot(k);
        if (reachable(g, s?.depth ?? null, p, to, m, osm)) {
          reopen = { ...reopen, state: 'found', hour: k };
          renderAnswer();
          return;
        }
        k++;
      }
      if (k >= n) {
        reopen = { ...reopen, state: 'none' };
        renderAnswer();
        return;
      }
      setTimeout(step, 16);
    };
    // wait for the timeline to settle before scanning ahead
    setTimeout(step, 450);
  }

  function setAnswer(state: 'idle' | 'ok' | 'wet' | 'detour' | 'blocked', lead: string, detail = '', extra = '') {
    const a = $('.pl-ans');
    a.dataset.state = state;
    const icon = state === 'ok' ? 'check' : state === 'idle' ? 'dots' : 'bang';
    a.querySelector('.pl-dot')!.innerHTML = ico(icon, 14, 2.6);
    a.querySelector('.pl-lead')!.textContent = lead;
    const [d1, d2] = a.querySelectorAll<HTMLElement>('.pl-detail');
    d1.textContent = detail;
    d1.hidden = !detail;
    d2.textContent = extra;
    d2.hidden = !extra;
  }

  function renderAnswer() {
    syncDestButtons();
    if (!place) return;
    if (!dest) return setAnswer('idle', 'Choose where you need to get to.');
    if (dest === 'custom' && !custom) return setAnswer('idle', 'Click the map to set a destination.');
    if (!last) return setAnswer('idle', 'Finding a route…');
    const { r, target, usualTarget } = last;
    const by = MODES[mode].by;
    const w = makeWhen(opts.getTimes());
    const at = engine.hours ? w.at(Math.floor(last.hour)) : 'now';
    if (!r) return setAnswer('blocked', `No ${dest === 'custom' ? 'route' : DEST_NOUN[dest]} found on the road map from here.`);
    if (r.error === 'off-network') return setAnswer('blocked', 'No mapped road within 600 m of this spot.');
    if (r.error === 'no-path') return setAnswer('blocked', `No road connection to ${target} on the map.`);
    const via = r.via.length ? ` via ${r.via.slice(0, 2).join(' and ')}` : '';
    const wetNote = r.wetLengthM >= 10 ? `${dist(r.wetLengthM)} of shallow water (up to ${cm(r.maxDepthM)})` : '';
    if (r.ok && !r.blocked) {
      if (r.lengthM < 40) return setAnswer('ok', dest === 'main_road' ? `You're on ${target} already.` : `You're right next to ${target}.`);
      if (!wetNote) return setAnswer('ok', `Reachable: ${dist(r.lengthM)}, ${mins(r.minutes)} ${by}, dry the whole way.`, `To ${target}${via}.`);
      return setAnswer('wet', `Reachable: ${dist(r.lengthM)}, ${mins(r.minutes)} ${by}, through ${wetNote}.`, `To ${target}${via}.`);
    }
    if (r.ok && r.blocked) {
      const b = r.blocked;
      const lead = usualTarget
        ? `${usualTarget} is cut off at ${at}: ${b.roadName} under ${cm(b.depthM)}. Go to ${target} instead: ${dist(r.lengthM)}, ${mins(r.minutes)}.`
        : `Blocked at ${at}: ${b.roadName} under ${cm(b.depthM)}. Detour ${dist(r.lengthM)}, ${mins(r.minutes)}.`;
      const detail = `${wetNote ? cap(wetNote) : 'Dry the whole way'}${via}.${r.usual ? ` The usual way is ${dist(r.usual.lengthM)}, ${mins(r.usual.minutes)} on a dry day.` : ''}`;
      return setAnswer('detour', lead, detail);
    }
    const b = r.blocked;
    const lead = b ? `Cut off at ${at}: ${b.roadName} under ${cm(b.depthM)}. No way through ${by}.` : `No passable route ${by} at ${at}.`;
    let detail = '';
    if (reopen.state === 'scan') detail = 'Checking when the water drops…';
    else if (reopen.state === 'found' && reopen.hour !== undefined) detail = `Passable again ${by} from ${w.at(reopen.hour)}.`;
    else if (reopen.state === 'none') detail = `Still cut off ${by} at the end of this run.`;
    const alt = reopen.alt?.length ? `Still possible ${reopen.alt.map((m) => MODES[m].by).join(' or ')}.` : '';
    setAnswer('blocked', lead, detail, alt);
  }

  // ------------------------------------------------------------------ commute check
  // Your place -> picked destination at a departure time: the spots news reports name as flooding
  // within 100 m of the usual route, rain from 2 h before to 2 h after leaving, and the model's
  // water at those spots at that hour (rules in src/commute/verdict.ts).
  const H = 3600e3;
  const commuteEl = $('.pl-commute');
  const depSeg = $('.pl-seg-dep');
  const timeIn = $<HTMLInputElement>('.pl-time input');
  const shareBtn = $<HTMLButtonElement>('.pl-share');
  const routeSpots = new RouteSpotsLayer(map);
  let news: NewsSpot[] = [];
  let commuteKey = '';
  const link = parseCommuteLink(location.search);
  const first = nextCommute(Date.now());
  let depSlot: 'am' | 'pm' | 'custom' = first.slot;
  let depHM: [number, number] = first.slot === 'am' ? [9, 0] : [18, 0];
  const hmText = (hm: [number, number]) => `${String(hm[0]).padStart(2, '0')}:${String(hm[1]).padStart(2, '0')}`;
  const slotOf = (hm: [number, number]): 'am' | 'pm' | 'custom' => (hm[1] ? 'custom' : hm[0] === 9 ? 'am' : hm[0] === 18 ? 'pm' : 'custom');
  if (link?.dep) {
    depHM = parseHHMM(link.dep)!;
    depSlot = slotOf(depHM);
  }
  void loadNewsSpots().then((s) => {
    news = s;
    renderCommute(true);
  });

  function syncDep() {
    [...depSeg.querySelectorAll<HTMLButtonElement>('button[data-slot]')].forEach((b, i) => {
      const on = b.dataset.slot === depSlot;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on || (depSlot === 'custom' && i === 0) ? 0 : -1;
      if (on) depSeg.style.setProperty('--i', String(i));
    });
    depSeg.classList.toggle('pl-seg-none', depSlot === 'custom');
    if (document.activeElement !== timeIn) timeIn.value = hmText(depHM);
  }
  depSeg.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-slot]');
    if (!b) return;
    depSlot = b.dataset.slot as 'am' | 'pm';
    depHM = depSlot === 'am' ? [9, 0] : [18, 0];
    renderCommute();
  });
  timeIn.addEventListener('change', () => {
    const p = parseHHMM(timeIn.value);
    if (!p) return;
    depHM = p;
    depSlot = slotOf(p);
    renderCommute();
  });
  shareBtn.addEventListener('click', async () => {
    if (!place || !custom) return;
    const q = commuteSearch(location.search, { from: place.coord, to: custom.coord, dep: hmText(depHM) });
    history.replaceState(history.state, '', `${location.pathname}${q}${location.hash}`);
    let msg = 'Link copied';
    try {
      await navigator.clipboard.writeText(`${location.origin}${location.pathname}${q}`);
    } catch {
      msg = 'Link is in the address bar';
    }
    shareBtn.textContent = msg;
    setTimeout(() => (shareBtn.textContent = 'Copy link to this commute'), 2500);
  });
  root.querySelector('.pl-spots')!.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-i]');
    const s = li ? lastSpots[Number(li.dataset.i)] : undefined;
    if (!s) return;
    if (opts.onFocus) opts.onFocus(s.coord);
    else map.flyTo({ center: s.coord, zoom: Math.max(map.getZoom(), 16), essential: true });
  });
  let lastSpots: NewsSpot[] = [];

  function setCommute(v: Verdict | 'idle', lead: string, detail = '', extra = '') {
    const a = $('.pl-cv');
    a.dataset.state = v === 'clear' ? 'ok' : v === 'watch' ? 'wet' : v === 'flooded' ? 'blocked' : 'idle';
    a.querySelector('.pl-dot')!.innerHTML = ico(v === 'clear' ? 'check' : v === 'idle' ? 'dots' : 'bang', 14, 2.6);
    a.querySelector('.pl-lead')!.textContent = lead;
    const [d1, d2] = a.querySelectorAll<HTMLElement>('.pl-detail');
    d1.textContent = detail;
    d1.hidden = !detail;
    d2.textContent = extra;
    d2.hidden = !extra;
  }

  function renderCommute(force = false) {
    if (!place || dest !== 'custom' || !custom) {
      commuteEl.hidden = true;
      routeSpots.set(null);
      commuteKey = '';
      return;
    }
    commuteEl.hidden = false;
    syncDep();
    const times = opts.getTimes();
    const mm = opts.getRain?.() ?? [];
    const t = nextWeekdayAt(Date.now(), depHM[0], depHM[1]);
    const key = [place.coord, custom.coord, mode, t, engine.hours, times[0], times.length, mm.reduce((a, b) => a + b, 0), news.length].join('|');
    if (!force && key === commuteKey) return;
    commuteKey = key;
    const g = G();
    const from = place.coord, to = custom.coord;
    const usual = route(g, null, from, to, mode);
    const near = spotsNearRoute(usual.coords, news, 100);
    const w = rainAround(times, mm, t, 2);
    const snapAt = (k: number) => (k >= 0 && k < engine.hours ? (engine.snapshot(k)?.depth ?? null) : null);
    const depthAt = (d: Float32Array | null, s: NewsSpot) => {
      if (!d) return null;
      const c = cellAt(meta, s.coord[0], s.coord[1]);
      return c >= 0 ? maxAround(d, meta, c, NEAR_M) : null;
    };
    const depth = snapAt(w.depIndex);
    const items = near.map((n) => {
      const d = depthAt(depth, n.spot);
      return { spot: n.spot, d, verdict: spotVerdict(d, w, n.spot.count) };
    });
    lastSpots = items.map((x) => x.spot);
    const when = `${new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ })}, ${fmtHHMM(t)}`;
    const win = `${fmtHHMM(t - 2 * H)}–${fmtHHMM(t + 2 * H)}`;

    // the spots on the route
    const sh = $('.pl-spots-h');
    sh.textContent = near.length
      ? `Your route passes ${near.length} spot${near.length === 1 ? '' : 's'} reported flooded in the news:`
      : usual.coords.length
        ? 'No spot reported flooded in the news lies within 100 m of this route.'
        : '';
    $('.pl-spots').innerHTML = items
      .map((x, i) => {
        const yrs = x.spot.firstYear === x.spot.lastYear ? `${x.spot.firstYear}` : `${x.spot.firstYear}–${x.spot.lastYear}`;
        const water = x.d !== null && x.d >= WET_M ? ` · ${cm(x.d)} modelled` : '';
        const v = w.inRange ? `<em>${VERDICT_TEXT[x.verdict]}${water}</em>` : '';
        return `<li data-i="${i}" data-v="${w.inRange ? x.verdict : 'none'}"><i aria-hidden="true"></i><span><b>${esc(x.spot.name)}</b><small>${x.spot.count} report day${x.spot.count === 1 ? '' : 's'}, ${yrs}</small>${v}</span></li>`;
      })
      .join('');
    routeSpots.set(items.map((x) => ({ spot: x.spot, verdict: w.inRange ? x.verdict : 'watch', note: w.inRange ? `${VERDICT_TEXT[x.verdict]}${x.d !== null && x.d >= WET_M ? ` · ${cm(x.d)}` : ''}` : '' })));

    if (!usual.coords.length) return setCommute('idle', 'No road connection between these two points on the map.');
    if (!w.inRange) {
      return setCommute('idle', `Leaving ${when}.`, 'That time is outside this prediction. Choose Live forecast under Rain to check the next weekday commute.');
    }
    const rDep = depth ? route(g, depth, from, to, mode) : null;
    const cut = !!rDep && (!rDep.ok || !!rDep.blocked);
    const trip = tripVerdict(
      items.map((x) => x.verdict),
      { blocked: cut, maxDepthM: rDep?.maxDepthM ?? 0 },
    );
    const spell = rainSpell(times, mm, t, 2);
    let clearAt: number | null = null;
    if (spell)
      for (let k = spell.i1 + 1; k < Math.min(engine.hours, spell.i1 + 13); k++) {
        const dk = snapAt(k);
        if (!dk) break;
        if (items.every((x) => (depthAt(dk, x.spot) ?? 0) < STALL_M) && reachable(g, dk, from, to, mode)) {
          clearAt = times[k];
          break;
        }
      }
    const rain = w.peakMm < 0.2 ? `No rain forecast ${win}.` : `${w.totalMm} mm of rain forecast ${win}, up to ${w.peakMm.toFixed(1)} mm in an hour.`;
    const deepest = items.filter((x) => x.d !== null && x.d >= STALL_M).sort((a, b) => b.d! - a.d!)[0];
    const why = cut && rDep?.blocked
      ? `The model cuts your route at ${rDep.blocked.roadName} (${cm(rDep.blocked.depthM)}). `
      : deepest
        ? `The model has ${cm(deepest.d!)} at ${deepest.spot.name}. `
        : '';
    const lead = trip === 'clear' ? `Likely clear if you leave ${when}.` : trip === 'watch' ? `Watch out if you leave ${when}.` : `Likely flooded if you leave ${when}.`;
    setCommute(trip, lead, `${why}${rain}`, trip === 'clear' ? '' : suggestion(spell, clearAt));
  }

  // ------------------------------------------------------------------ init
  syncModes();
  syncDestButtons();
  if (saved.place && Array.isArray(saved.place.coord) && saved.place.coord.length === 2 && inBBox(meta, saved.place.coord)) {
    const sp = saved.place;
    place = { coord: sp.coord, label: sp.label || 'Your place', sub: sp.sub || '', kind: sp.kind || 'pin', cell: cellAt(meta, sp.coord[0], sp.coord[1]), labelFixed: true };
    layer.setPlace(sp.coord);
    hint.hidden = true;
    card.hidden = false;
    out.hidden = false;
    renderHead();
    computeSeries();
    idle(() => runRoute(false));
  }
  // a shared commute link (?from=lng,lat&to=lng,lat&dep=HH:MM) inside this pincode's model
  if (link && inBBox(meta, link.from) && inBBox(meta, link.to)) {
    pinAt(link.from);
    const d = describePoint(link.to);
    custom = { coord: link.to, label: d.label === 'Dropped pin' ? 'Pinned destination' : d.label };
    dest = 'custom';
    syncDestButtons();
    save();
    idle(() => runRoute(true));
  }
  idle(() => {
    I();
    G();
  });
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    let lastW = 0;
    ro = new ResizeObserver(() => {
      const wNow = Math.round($('.pl-spark-svg').clientWidth);
      if (wNow && wNow !== lastW) {
        lastW = wNow;
        if (series) renderNow();
      }
    });
    ro.observe(container);
  }

  return {
    setHour(h: number) {
      if (!Number.isFinite(h)) return;
      hour = h;
      renderNow();
      scheduleRoute();
    },
    refresh() {
      hour = opts.getHour();
      if (!place) return;
      computeSeries();
      runRoute(false);
    },
    destroy() {
      seriesJob++;
      scanJob++;
      clearTimeout(routeTimer);
      clearTimeout(lpTimer);
      clearTimeout(flashTimer);
      if (picking) stopPicking();
      map.off('click', onMapClick);
      canvasBox.removeEventListener('mousedown', onMouseDown);
      canvasBox.removeEventListener('mouseup', onMouseUp);
      canvasBox.removeEventListener('contextmenu', onCtx);
      canvasBox.removeEventListener('touchstart', onTouchStart);
      canvasBox.removeEventListener('touchmove', onTouchMove);
      canvasBox.removeEventListener('touchend', lpCancel);
      canvasBox.removeEventListener('touchcancel', lpCancel);
      document.removeEventListener('pointerdown', onDocDown);
      document.removeEventListener('keydown', onKey, true);
      ro?.disconnect();
      routeSpots.destroy();
      layer.destroy();
      container.innerHTML = '';
    },
    pin(coord: [number, number], label?: string) {
      pinAt(coord, label ? { label, sub: I().areaOf(coord), kind: 'pin' } : undefined);
    },
    unpin,
  };
}
