// Pincode pack manifest + loader helpers (Bengaluru Urban).
//
// Layout (see CONTRACT.md "Packs"):
//   <packs root>/index.json          PinIndex: every pincode in the district, with its pack if built
//   <packs root>/<code>/meta.json    TerrainMeta (+ format)        grids.bin
//                      /osm.geojson  depressions.json  hotspots.json (optional)
//   data/hotspots-city.json          sourced flood reports across the district (ships with the app)
// The 560098 reference pack ships with the app in data/pins/560098; pack.path "." (indexes written
// before it moved out of public/data) resolves there too, whatever the packs root.
import type { Hotspot, PinEntry, PinIndex, TerrainMeta } from '../types.ts';
import { layerBytes } from '../pack/codec.ts';

export const LEGACY_PIN = '560098';

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const BASE = (env?.BASE_URL ?? '/').replace(/\/?$/, '/');
/** packs bundled with the app (public/data/pins), whatever `?packs=` says */
export const BUNDLED_PACKS = `${BASE}data/pins`;

/**
 * Hosts `?packs=` may point at besides the page's own origin; VITE_PACK_HOSTS (comma-separated) adds
 * more at build time. A link to any other host is ignored, so nobody can show their own made-up flood
 * data under this site's address.
 */
export const PACK_HOSTS: readonly string[] = [
  'achyuta0001.github.io',
  ...(env?.VITE_PACK_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
];

/** `?packs=` value allowed: a path or URL on the page's own origin, or https on a PACK_HOSTS host */
export function allowedPacksUrl(q: string, origin: string): boolean {
  try {
    const u = new URL(q, origin);
    if (u.origin === origin) return true;
    return u.protocol === 'https:' && PACK_HOSTS.includes(u.host);
  } catch {
    return false;
  }
}

/**
 * Where packs live. Defaults to the bundled public/data/pins; `?packs=<url>` (allowed hosts only, see
 * PACK_HOSTS) or VITE_PACKS_URL point it at a hosted copy (a release asset or a Pages artifact built by
 * `npm run data:all`).
 */
export function packsRoot(
  search: string = typeof location !== 'undefined' ? location.search : '',
  origin: string = typeof location !== 'undefined' ? location.origin : 'http://localhost',
): string {
  const q = new URLSearchParams(search).get('packs');
  const ok = !!q && /^(https?:)?\/\/|^\//.test(q) && allowedPacksUrl(q, origin);
  if (q && !ok) console.warn('[packs] ?packs= ignored: not this site or an allowed host', q);
  const root = ok ? q : env?.VITE_PACKS_URL || BUNDLED_PACKS;
  return root.replace(/\/$/, '');
}

/** Base URL of one pincode's pack (what loadDataset() takes). Path "." is the bundled reference pack. */
export function packBase(root: string, pin: PinEntry): string {
  if (!pin.pack) throw new Error(`No data pack for ${pin.code}`);
  return pin.pack.path === '.' ? `${BUNDLED_PACKS}/${LEGACY_PIN}` : `${root}/${pin.pack.path}`;
}

/** Minimal index used when index.json is missing: just the reference pack. */
export function fallbackIndex(meta?: Pick<TerrainMeta, 'bbox' | 'boundary' | 'name'>): PinIndex {
  const bbox = meta?.bbox ?? [77.4930, 12.8864, 77.5383, 12.9423];
  return {
    version: 1,
    generated: '',
    district: { relation: 2020589, name: 'Bengaluru Urban' },
    rule: 'fallback: reference pack only',
    pins: [
      {
        code: LEGACY_PIN,
        name: meta?.name ?? 'Rajarajeshwari Nagar',
        relation: 17817376,
        bbox,
        centroid: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
        areaKm2: 11,
        districtShare: 1,
        pack: { path: '.', format: 2, bytes: 0, gzipBytes: 0, built: '', sources: [] },
      },
    ],
  };
}

type FetchFn = (url: string) => Promise<Pick<Response, 'ok' | 'status' | 'json' | 'headers'>>;

/** Load and check index.json; falls back to the reference pack alone when it is missing. */
export async function loadPinIndex(root: string = packsRoot(), fetchFn: FetchFn = (u) => fetch(u)): Promise<PinIndex> {
  try {
    const r = await fetchFn(`${root}/index.json`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if ((r.headers.get('content-type') ?? '').includes('text/html')) throw new Error('missing'); // dev-server SPA fallback
    const idx = (await r.json()) as PinIndex;
    const errs = validatePinIndex(idx);
    if (errs.length) throw new Error(`index.json: ${errs.slice(0, 3).join('; ')}`);
    // the reference pack is always available, even if a hosted index forgot it
    if (!idx.pins.some((p) => p.code === LEGACY_PIN && p.pack)) {
      const fb = fallbackIndex().pins[0];
      const at = idx.pins.findIndex((p) => p.code === LEGACY_PIN);
      if (at >= 0) idx.pins[at] = { ...idx.pins[at], pack: fb.pack };
      else idx.pins.push(fb);
    }
    return idx;
  } catch (e) {
    console.warn('[packs] index unavailable, using the reference pack only', e);
    return fallbackIndex();
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBBox = (b: unknown) => Array.isArray(b) && b.length === 4 && b.every(isNum) && b[0] < b[2] && b[1] < b[3];

/** Schema check for index.json. Returns human-readable problems (empty = valid). */
export function validatePinIndex(x: unknown): string[] {
  const errs: string[] = [];
  const idx = x as PinIndex;
  if (!idx || typeof idx !== 'object') return ['not an object'];
  if (idx.version !== 1) errs.push(`version ${String(idx.version)} (expected 1)`);
  if (!Array.isArray(idx.pins)) return [...errs, 'pins is not an array'];
  const seen = new Set<string>();
  idx.pins.forEach((p, i) => {
    const at = `pins[${i}]${p?.code ? ` (${p.code})` : ''}`;
    if (!p || !/^\d{6}$/.test(p.code)) errs.push(`${at}: code must be 6 digits`);
    else if (seen.has(p.code)) errs.push(`${at}: duplicate code`);
    else seen.add(p.code);
    if (typeof p?.name !== 'string') errs.push(`${at}: name missing`);
    if (!isNum(p?.relation)) errs.push(`${at}: relation missing`);
    if (!isBBox(p?.bbox)) errs.push(`${at}: bad bbox`);
    if (!Array.isArray(p?.centroid) || !p.centroid.every(isNum)) errs.push(`${at}: bad centroid`);
    if (!isNum(p?.areaKm2) || p.areaKm2 <= 0) errs.push(`${at}: bad areaKm2`);
    if (!isNum(p?.districtShare) || p.districtShare < 0 || p.districtShare > 1) errs.push(`${at}: bad districtShare`);
    if (p?.susceptibility !== undefined && !(isNum(p.susceptibility) && p.susceptibility >= 0 && p.susceptibility <= 1)) errs.push(`${at}: susceptibility outside 0..1`);
    if (p?.pack) {
      const k = p.pack;
      if (typeof k.path !== 'string' || !k.path || k.path.includes('..')) errs.push(`${at}: bad pack.path`);
      if (k.format !== 1 && k.format !== 2) errs.push(`${at}: unknown pack.format ${String(k.format)}`);
      if (!isNum(k.bytes) || !isNum(k.gzipBytes)) errs.push(`${at}: pack sizes missing`);
      if (!Array.isArray(k.sources)) errs.push(`${at}: pack.sources missing`);
    }
  });
  return errs;
}

/** Schema check for a pack's meta.json against its grids.bin length. */
export function validateMeta(meta: TerrainMeta, binBytes?: number): string[] {
  const errs: string[] = [];
  if (!meta || typeof meta !== 'object') return ['not an object'];
  if (!/^\d{6}$/.test(String(meta.pincode))) errs.push('pincode must be 6 digits');
  if (meta.format !== undefined && meta.format !== 1 && meta.format !== 2) errs.push(`unknown format ${String(meta.format)}`);
  if (!isBBox(meta.bbox)) errs.push('bad bbox');
  if (!(Number.isInteger(meta.width) && meta.width > 0 && Number.isInteger(meta.height) && meta.height > 0)) errs.push('bad width/height');
  if (!isNum(meta.cellSizeM) || meta.cellSizeM <= 0) errs.push('bad cellSizeM');
  if (!meta.boundary || !/Polygon/.test(meta.boundary.type)) errs.push('boundary must be a (Multi)Polygon');
  const need = ['elevation', 'filled', 'depressionDepth', 'flowAccum', 'flowDir', 'hand', 'impervious', 'drainMask', 'lakeMask', 'boundaryMask'] as const;
  const n = meta.width * meta.height;
  for (const k of need) {
    const l = meta.layers?.[k];
    if (!l) {
      errs.push(`layer ${k} missing`);
      continue;
    }
    if (l.length !== n) errs.push(`layer ${k}: length ${l.length} != ${n}`);
    if (l.derived && k !== 'filled') errs.push(`layer ${k}: only filled can be derived`);
    if (!['f32', 'u8', 'u16'].includes(l.dtype)) errs.push(`layer ${k}: unknown dtype ${String(l.dtype)}`);
    if (binBytes !== undefined && l.offset + layerBytes(l) > binBytes) errs.push(`layer ${k}: past the end of grids.bin`);
  }
  // M4 upstream inflow points (optional)
  if (meta.inflow !== undefined) {
    if (!Array.isArray(meta.inflow)) errs.push('inflow must be an array');
    else
      meta.inflow.forEach((p, i) => {
        if (!(Number.isInteger(p?.cell) && p.cell >= 0 && p.cell < n)) errs.push(`inflow[${i}]: cell outside the grid`);
        if (!(isNum(p?.areaKm2) && p.areaKm2 > 0)) errs.push(`inflow[${i}]: bad areaKm2`);
        if (!(isNum(p?.impervious) && p.impervious >= 0 && p.impervious <= 1)) errs.push(`inflow[${i}]: impervious outside 0..1`);
        if (!(Array.isArray(p?.timeArea) && p.timeArea.length > 0 && p.timeArea.every((v) => isNum(v) && v >= 0))) errs.push(`inflow[${i}]: bad timeArea`);
      });
  }
  // M4 inflow edge runs [side, from, to] (optional)
  if (meta.inflowEdge !== undefined) {
    if (!Array.isArray(meta.inflowEdge)) errs.push('inflowEdge must be an array');
    else
      meta.inflowEdge.forEach((r, i) => {
        const len = r?.[0] < 2 ? meta.width : meta.height;
        if (!(Array.isArray(r) && r.length === 3 && [0, 1, 2, 3].includes(r[0]) && Number.isInteger(r[1]) && Number.isInteger(r[2]) && r[1] >= 0 && r[1] <= r[2] && r[2] < len))
          errs.push(`inflowEdge[${i}]: not a [side 0-3, from, to] run along the grid edge`);
      });
  }
  return errs;
}

/**
 * M4 caveat for a pincode: how much land drains into its map from outside, and how much of that the
 * sim routes in (meta.inflow, src/sim/inflow.ts). Null when there is nothing worth a line.
 */
export function inflowCaveat(pin: PinEntry): { text: string; tip: string } | null {
  const total = pin.pack?.upstreamOutsideKm2 ?? 0;
  const sim = Math.min(pin.pack?.inflowKm2 ?? 0, total > 0 ? total : Infinity);
  const rest = Math.max(0, total - sim);
  const large = (km2: number) => km2 >= Math.max(5, pin.areaKm2);
  const km2 = (v: number) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1));
  if (sim >= 1) {
    return {
      text: large(rest)
        ? `Water from ${km2(sim)} km² upstream is routed in from outside this map; about ${km2(rest)} km² more is left out.`
        : `Water from about ${km2(sim)} km² upstream is routed in from outside this map.`,
      tip:
        'Upstream land from a district-wide 60 m flow routing (npm run data:city). Its runoff, after the same drain, soil and tank losses, ' +
        'enters at the map edge through a lumped Clark unit hydrograph rather than a full 2D simulation, so valley timing and depths are approximate.',
    };
  }
  if (!large(total)) return null;
  return {
    text: `About ${Math.round(total)} km² upstream drains in from outside this map; the model leaves that inflow out.`,
    tip: 'Upstream area from a district-wide 60 m flow-accumulation run (npm run data:city). Streams entering from outside the modelled area are not simulated, so valley-floor depths may be underestimated.',
  };
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Search pincodes by number ("5600", "560 034") or locality name ("hsr", "bellandur").
 * Offline over index.json only (no geocoder). Ranked: exact code, code prefix, name prefix, word prefix, substring.
 */
export function searchPins(index: PinIndex, q: string, limit = 8): PinEntry[] {
  const digits = q.replace(/\s+/g, '');
  const scored: { p: PinEntry; s: number }[] = [];
  if (/^\d{2,6}$/.test(digits)) {
    for (const p of index.pins) {
      if (p.code === digits) scored.push({ p, s: 0 });
      else if (p.code.startsWith(digits)) scored.push({ p, s: 1 });
    }
  } else {
    const n = norm(q);
    if (n.length < 2) return [];
    for (const p of index.pins) {
      let best = Infinity;
      for (const [i, name] of [p.name, ...(p.localities ?? [])].entries()) {
        const t = norm(name);
        const pen = i === 0 ? 0 : 0.5; // the pincode's own name ranks above a locality inside it
        if (t === n) best = Math.min(best, 2 + pen);
        else if (t.startsWith(n)) best = Math.min(best, 3 + pen);
        else if (t.split(' ').some((w) => w.startsWith(n))) best = Math.min(best, 4 + pen);
        else if (t.includes(n) || t.replace(/ /g, '').includes(n.replace(/ /g, ''))) best = Math.min(best, 5 + pen);
      }
      if (best < Infinity) scored.push({ p, s: best });
    }
  }
  scored.sort((a, b) => a.s - b.s || Number(!!b.p.pack) - Number(!!a.p.pack) || a.p.code.localeCompare(b.p.code));
  return scored.slice(0, limit).map((x) => x.p);
}

// ---------------------------------------------------------------- sourced flood reports (hotspots)

/** public/data/hotspots-city.json entry: a Hotspot, plus the OSM object its coordinate came from when known */
export type CityHotspot = Hotspot & { osm?: string };

/** URL of the district-wide sourced flood reports (ships with the app, like the reference pack) */
export const CITY_HOTSPOTS_URL = `${BASE}data/hotspots-city.json`;

const isHotspot = (h: unknown): h is Hotspot => {
  const x = h as Hotspot;
  return !!x && typeof x.name === 'string' && Array.isArray(x.coord) && x.coord.length === 2 && x.coord.every(isNum) && Array.isArray(x.events);
};

/** [lon, lat] inside bbox [west, south, east, north], edges included */
export const inBBox = ([lon, lat]: readonly number[], [w, s, e, n]: readonly number[]): boolean => lon >= w && lon <= e && lat >= s && lat <= n;

/**
 * The reports inside a pack's bbox: its grid (meta.bbox), i.e. the pincode's bbox plus the margin the
 * model covers. One rule for the build (pack hotspots.json), calibrate.mjs and the app. Returns plain
 * Hotspots (build-only fields such as `osm` dropped), in file order.
 */
export function hotspotsInBBox(spots: readonly unknown[], bbox: readonly number[]): Hotspot[] {
  return spots.filter(isHotspot).filter((h) => inBBox(h.coord, bbox)).map(({ name, coord, events }) => ({ name, coord, events }));
}

const metres = (a: readonly number[], b: readonly number[]) => {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * 111320 * k, (a[1] - b[1]) * 110574);
};

/**
 * A pack's reports: the district-wide ones inside its bbox, then any of the pack's own hotspots.json
 * that the city file does not have (same name, or within 25 m, counts as the same spot; the city file
 * wins as it is the newer source). A pack built before a report was added still shows it.
 */
export function mergeHotspots(own: readonly Hotspot[], city: readonly unknown[], bbox: readonly number[]): Hotspot[] {
  const here = hotspotsInBBox(city, bbox);
  const key = (s: string) => norm(s);
  const same = (a: Hotspot, b: Hotspot) => key(a.name) === key(b.name) || metres(a.coord, b.coord) < 25;
  return [...here, ...own.filter((o) => isHotspot(o) && !here.some((c) => same(o, c)))];
}

/** Load the district-wide reports (empty when unavailable: the packs' own hotspots.json still work). */
export async function loadCityHotspots(url: string = CITY_HOTSPOTS_URL, fetchFn: FetchFn = (u) => fetch(u)): Promise<Hotspot[]> {
  try {
    const r = await fetchFn(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if ((r.headers.get('content-type') ?? '').includes('text/html')) throw new Error('missing'); // dev-server SPA fallback
    const all = (await r.json()) as unknown;
    if (!Array.isArray(all)) throw new Error('not an array');
    return all.filter(isHotspot);
  } catch (e) {
    console.warn('[packs] city-wide flood reports unavailable', e);
    return [];
  }
}
