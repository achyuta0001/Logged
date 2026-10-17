// Pincode pack manifest + loader helpers (Bengaluru Urban).
//
// Layout (see CONTRACT.md "Packs"):
//   <packs root>/index.json          PinIndex: every pincode in the district, with its pack if built
//   <packs root>/<code>/meta.json    TerrainMeta (+ format)        grids.bin
//                      /osm.geojson  depressions.json  hotspots.json (optional)
// The 560098 reference pack stays in public/data (pack.path "."), so old links keep working.
import type { PinEntry, PinIndex, TerrainMeta } from '../types.ts';

export const LEGACY_PIN = '560098';

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const BASE = (env?.BASE_URL ?? '/').replace(/\/?$/, '/');

/**
 * Where packs live. Defaults to the bundled public/data/pins; `?packs=<url>` or VITE_PACKS_URL point it
 * at a hosted copy (a release asset or a Pages artifact built by `npm run data:all`).
 */
export function packsRoot(search: string = typeof location !== 'undefined' ? location.search : ''): string {
  const q = new URLSearchParams(search).get('packs');
  const root = q && /^(https?:)?\/\/|^\//.test(q) ? q : env?.VITE_PACKS_URL || `${BASE}data/pins`;
  return root.replace(/\/$/, '');
}

/** Base URL of one pincode's pack (what loadDataset() takes). */
export function packBase(root: string, pin: PinEntry): string {
  if (!pin.pack) throw new Error(`No data pack for ${pin.code}`);
  return pin.pack.path === '.' ? `${BASE}data` : `${root}/${pin.pack.path}`;
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
        pack: { path: '.', format: 1, bytes: 0, gzipBytes: 0, built: '', sources: [] },
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
    if (binBytes !== undefined && l.offset + l.length * (l.dtype === 'f32' ? 4 : 1) > binBytes) errs.push(`layer ${k}: past the end of grids.bin`);
  }
  return errs;
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
