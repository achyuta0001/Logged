// Offline place search over the local data only (osm.geojson, depressions.json, hotspots.json).
// No geocoding service: Nominatim's usage policy forbids search-as-you-type, and everything we
// need (named roads, schools, hospitals, stops, lakes, low spots) is already in public/data.
import type { Depression, Hotspot, OsmKind, OsmProps, TerrainMeta } from '../types.ts';
import { cellAt, cellCenter, distM, inBBox, type LngLat } from './geo.ts';

export type PlaceKind = OsmKind | 'lowspot' | 'hotspot' | 'coord';

export interface SearchResult {
  label: string;
  /** kind and area, e.g. "Main road · BEML Layout 5th Stage" */
  sublabel: string;
  coord: LngLat;
  /** grid cell (row * width + col), -1 outside the modelled grid */
  cell: number;
  kind: PlaceKind;
}

export interface SearchIndex {
  search(query: string, limit?: number): SearchResult[];
  /** locality name near a point ("" if none known) */
  areaOf(p: LngLat): string;
  /** closest named landmark (not a road) within maxM */
  landmarkNear(p: LngLat, maxM?: number): SearchResult | null;
  readonly size: number;
}

type OsmFCLike = GeoJSON.FeatureCollection<GeoJSON.Geometry | null, OsmProps>;

interface Entry extends SearchResult {
  norm: string;
  tokens: string[];
  kindTokens: string[];
  weight: number;
}

const KIND_LABEL: Partial<Record<PlaceKind, string>> = {
  metro: 'Metro station',
  hospital: 'Hospital',
  clinic: 'Clinic',
  school: 'School',
  bus_stop: 'Bus stop',
  market: 'Market',
  park: 'Park',
  police: 'Police station',
  fire_station: 'Fire station',
  substation: 'Power substation',
  worship: 'Place of worship',
  water: 'Lake',
  lowspot: 'Low spot',
  hotspot: 'Reported flood spot',
};

/** extra words that find a kind even when its name does not contain them */
const KIND_WORDS: Partial<Record<PlaceKind, string[]>> = {
  metro: ['metro', 'station', 'namma', 'train'],
  hospital: ['hospital', 'emergency', 'medical'],
  clinic: ['clinic', 'doctor', 'medical'],
  school: ['school', 'college'],
  bus_stop: ['bus', 'stop', 'bmtc'],
  market: ['market', 'shop', 'mall', 'store'],
  park: ['park', 'garden', 'ground'],
  police: ['police', 'station'],
  fire_station: ['fire', 'station'],
  substation: ['substation', 'power', 'bescom', 'kptcl'],
  worship: ['temple', 'church', 'mosque', 'masjid', 'worship'],
  water: ['lake', 'kere', 'tank'],
  lowspot: ['low', 'spot', 'depression', 'basin'],
  hotspot: ['flood', 'flooded', 'reported'],
  road: ['road', 'street'],
};

const KIND_WEIGHT: Partial<Record<PlaceKind, number>> = {
  metro: 22,
  hospital: 20,
  police: 14,
  fire_station: 14,
  hotspot: 14,
  school: 12,
  clinic: 12,
  market: 11,
  road: 10,
  park: 9,
  water: 9,
  bus_stop: 8,
  worship: 6,
  substation: 5,
  lowspot: 4,
};

const ABBR: Record<string, string> = {
  rd: 'road',
  st: 'street',
  cr: 'cross',
  crs: 'cross',
  x: 'cross',
  mn: 'main',
  ln: 'lane',
  blk: 'block',
  stg: 'stage',
  ph: 'phase',
  hosp: 'hospital',
  ft: 'feet',
  stn: 'station',
  univ: 'university',
  clg: 'college',
  govt: 'government',
  mysuru: 'mysore',
  bangalore: 'bengaluru',
  rajarajeswari: 'rajarajeshwari',
  rajajeshwari: 'rajarajeshwari',
};
/** extra tokens added to entries (so "rr nagar" finds Rajarajeshwari Nagar) */
const SYN: Record<string, string[]> = { rajarajeshwari: ['rr'], kere: ['lake'], lake: ['kere'], mysore: ['mysuru'] };

function normTokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((t) => {
      const o = t.match(/^(\d+)(st|nd|rd|th)$/);
      if (o) return o[1];
      return ABBR[t] ?? t;
    });
}

/** optimal-string-alignment distance, bailing out above `max` */
function osa(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length, m = b.length;
  let pp = new Array<number>(m + 1).fill(0);
  let p = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const c = new Array<number>(m + 1);
    c[0] = i;
    let rowMin = c[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, pp[j - 2] + 1);
      c[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    pp = p;
    p = c;
  }
  return p[m];
}

/** how well one query token matches one entry token, 0..1 */
function tokenScore(q: string, t: string, last: boolean): number {
  if (q === t) return 1;
  const num = /^\d+$/.test(q);
  if (t.startsWith(q)) return num ? (last ? 0.35 : 0) : q.length === 1 ? 0.45 : 0.82;
  if (num || q.length < 4) return 0;
  const max = q.length >= 7 ? 2 : 1;
  // typo in a whole word, or in a word still being typed (compare against the same-length prefix)
  const d = Math.min(osa(q, t, max), last && t.length > q.length ? osa(q, t.slice(0, q.length), max) : max + 1);
  return d <= max ? 0.62 - 0.14 * d : 0;
}

function scoreEntry(e: Entry, q: string[], qNorm: string): number {
  let sum = 0;
  let order = 0, lastPos = -1, kindOnly = true;
  for (let i = 0; i < q.length; i++) {
    const last = i === q.length - 1;
    let best = 0, pos = -1;
    for (let j = 0; j < e.tokens.length; j++) {
      const s = tokenScore(q[i], e.tokens[j], last);
      if (s > best) {
        best = s;
        pos = j;
      }
    }
    let kind = 0;
    for (const t of e.kindTokens) kind = Math.max(kind, q[i] === t ? 0.85 : Math.min(0.55, tokenScore(q[i], t, last)));
    if (kind > best) {
      best = kind;
      pos = -1;
    } else kindOnly = false;
    if (best <= 0) return 0;
    if (pos > lastPos) order++;
    if (pos >= 0) lastPos = pos;
    sum += best;
  }
  let s = (sum / q.length) * 100;
  // a pure category query ("metro", "hospital") lists that category first
  if (kindOnly) s += 45;
  if (e.norm === qNorm) s += 50;
  else if (e.norm.startsWith(qNorm)) s += 30;
  if (q.length > 1 && order === q.length) s += 8;
  s -= Math.max(0, e.tokens.length - q.length) * 1.5;
  return s + e.weight;
}

/** "12.92, 77.51" / "77.51 12.92" / "12.92N 77.51E" -> [lng, lat] */
export function parseLatLng(q: string, meta?: TerrainMeta): LngLat | null {
  const m = q.trim().match(/^\(?\s*(-?\d{1,3}(?:\.\d+)?)\s*°?\s*([NSEW])?\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*°?\s*([NSEW])?\s*\)?$/i);
  if (!m || !/\./.test(m[1] + m[3])) return null;
  let a = +m[1], b = +m[3];
  const ha = m[2]?.toUpperCase(), hb = m[4]?.toUpperCase();
  if (ha === 'S' || ha === 'W') a = -a;
  if (hb === 'S' || hb === 'W') b = -b;
  let lat = a, lng = b;
  const swap = ha === 'E' || ha === 'W' || hb === 'N' || hb === 'S' || Math.abs(a) > 90 || (!!meta && !inBBox(meta, [b, a]) && inBBox(meta, [a, b]));
  if (swap) [lat, lng] = [b, a];
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lng, lat];
}

const roadKind = (hw: string) => (/^motorway/.test(hw) ? 'Expressway' : /^(trunk|primary|secondary)/.test(hw) ? 'Main road' : /^tertiary/.test(hw) ? 'Road' : 'Street');
const ROAD_RANK = (hw: string) => (/^motorway/.test(hw) ? 4 : /^trunk/.test(hw) ? 5 : /^(primary|secondary)/.test(hw) ? 4 : /^tertiary/.test(hw) ? 3 : hw === 'service' ? 0 : 1);

export function buildSearchIndex(osm: OsmFCLike, meta: TerrainMeta, extra: { depressions?: Depression[]; hotspots?: Hotspot[] } = {}): SearchIndex {
  // ---- localities (for "area" sublabels): depression labels "Road, Locality" carry the nearest OSM place
  const localities: { name: string; p: LngLat }[] = [];
  for (const d of extra.depressions ?? []) {
    const parts = (d.label ?? '').split(', ');
    if (parts.length >= 2) localities.push({ name: parts.slice(1).join(', '), p: d.centroid });
  }
  const areaOf = (p: LngLat, maxM = 1300) => {
    let best = '', bd = maxM;
    for (const l of localities) {
      const d = distM(p, l.p);
      if (d < bd) {
        bd = d;
        best = l.name;
      }
    }
    return best;
  };

  const entries: Entry[] = [];
  const add = (label: string, kind: PlaceKind, coord: LngLat, sub: string, weight = 0) => {
    const tokens = normTokens(label);
    if (!tokens.length) return;
    for (const t of [...tokens]) for (const s of SYN[t] ?? []) tokens.push(s);
    const area = areaOf(coord);
    const showArea = area && !label.toLowerCase().includes(area.toLowerCase());
    entries.push({
      label,
      sublabel: [sub, showArea ? area : ''].filter(Boolean).join(' · '),
      coord,
      cell: cellAt(meta, coord[0], coord[1]),
      kind,
      norm: tokens.join(' '),
      tokens,
      kindTokens: KIND_WORDS[kind] ?? [],
      weight: (KIND_WEIGHT[kind] ?? 0) + weight,
    });
  };

  // ---- named roads: merge segments by name, split into spatially separate clusters
  const byName = new Map<string, { cs: GeoJSON.Position[]; hw: string; len: number }[]>();
  for (const f of osm.features) {
    const p = f.properties;
    if (!p || p.kind !== 'road' || !p.name || f.geometry?.type !== 'LineString') continue;
    const arr = byName.get(p.name) ?? [];
    arr.push({ cs: f.geometry.coordinates, hw: p.highway ?? '', len: p.lengthM ?? 0 });
    byName.set(p.name, arr);
  }
  for (const [name, segs] of byName) {
    const parent = segs.map((_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const touches = (a: GeoJSON.Position[], b: GeoJSON.Position[]) => {
      for (const e of [a[0], a[a.length - 1]]) for (const v of b) if (distM(e as LngLat, v as LngLat) < 60) return true;
      return false;
    };
    for (let i = 0; i < segs.length; i++)
      for (let j = i + 1; j < segs.length; j++) if (find(i) !== find(j) && (touches(segs[i].cs, segs[j].cs) || touches(segs[j].cs, segs[i].cs))) parent[find(i)] = find(j);
    const groups = new Map<number, typeof segs>();
    segs.forEach((s, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), s]));
    for (const g of groups.values()) {
      // representative point: the vertex nearest the cluster's length-weighted centre
      let sx = 0, sy = 0, sw = 0, len = 0, rank = 0, hw = '';
      for (const s of g) {
        len += s.len;
        if (ROAD_RANK(s.hw) > rank || !hw) {
          rank = ROAD_RANK(s.hw);
          hw = s.hw;
        }
        for (let k = 0; k + 1 < s.cs.length; k++) {
          const w = distM(s.cs[k] as LngLat, s.cs[k + 1] as LngLat);
          sx += ((s.cs[k][0] + s.cs[k + 1][0]) / 2) * w;
          sy += ((s.cs[k][1] + s.cs[k + 1][1]) / 2) * w;
          sw += w;
        }
      }
      if (!sw) continue;
      const c: LngLat = [sx / sw, sy / sw];
      let best = g[0].cs[0], bd = Infinity;
      for (const s of g) for (const v of s.cs) {
        const d = distM(c, v as LngLat);
        if (d < bd) {
          bd = d;
          best = v;
        }
      }
      const km = len >= 950 ? `${(len / 1000).toFixed(1)} km` : '';
      add(name, 'road', [best[0], best[1]], [roadKind(hw), km].filter(Boolean).join(', '), rank * 2 + Math.min(6, len / 400));
    }
  }

  // ---- points of interest
  for (const f of osm.features) {
    const p = f.properties;
    if (!p || !p.name || p.kind === 'road' || p.kind === 'building' || p.kind === 'drain') continue;
    const coord: LngLat = f.geometry?.type === 'Point' ? (f.geometry.coordinates as LngLat) : cellCenter(meta, p.cell);
    let sub = KIND_LABEL[p.kind] ?? p.kind;
    if (p.kind === 'school' && /college|university|institute/i.test(p.name)) sub = 'College';
    if (p.kind === 'market' && /mall|arcade/i.test(p.name)) sub = 'Mall';
    add(p.name, p.kind, coord, sub);
  }

  // ---- reported flood spots and the biggest modelled low spots
  for (const h of extra.hotspots ?? []) {
    const years = h.events.map((e) => e.date.slice(0, 4)).filter(Boolean).sort();
    add(h.name, 'hotspot', h.coord, `Reported flooding${years.length ? ` ${years[years.length - 1]}` : ''}`);
  }
  const seenLow = new Set<string>();
  for (const d of [...(extra.depressions ?? [])].sort((a, b) => b.volumeM3 - a.volumeM3)) {
    const label = d.label?.replace(/^near /, '') ?? '';
    if (!label || seenLow.has(label) || seenLow.size >= 40) continue;
    seenLow.add(label);
    add(`Low spot: ${label}`, 'lowspot', d.centroid, `Pools up to ${d.maxDepthM.toFixed(1)} m`);
  }

  const landmarks = entries.filter((e) => e.kind !== 'road' && e.kind !== 'lowspot' && e.kind !== 'hotspot' && e.kind !== 'water' && e.kind !== 'park');

  return {
    size: entries.length,
    areaOf: (p) => areaOf(p),
    landmarkNear(p, maxM = 40) {
      let best: Entry | null = null, bd = maxM;
      for (const e of landmarks) {
        const d = distM(p, e.coord);
        if (d < bd) {
          bd = d;
          best = e;
        }
      }
      return best ? strip(best) : null;
    },
    search(query, limit = 8) {
      const ll = parseLatLng(query, meta);
      if (ll) {
        const inside = inBBox(meta, ll);
        const area = inside ? areaOf(ll) : '';
        return [
          {
            label: `${ll[1].toFixed(5)}, ${ll[0].toFixed(5)}`,
            sublabel: inside ? ['Coordinates', area].filter(Boolean).join(' · ') : 'Coordinates · outside the modelled area',
            coord: ll,
            cell: cellAt(meta, ll[0], ll[1]),
            kind: 'coord',
          },
        ];
      }
      const q = normTokens(query);
      if (!q.length) return [];
      const qNorm = q.join(' ');
      const scored: { e: Entry; s: number }[] = [];
      for (const e of entries) {
        const s = scoreEntry(e, q, qNorm);
        if (s > 0) scored.push({ e, s });
      }
      scored.sort((a, b) => b.s - a.s || a.e.label.length - b.e.label.length);
      const out: SearchResult[] = [];
      const seen = new Set<string>();
      for (const { e } of scored) {
        const k = `${e.label}|${e.sublabel}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(strip(e));
        if (out.length >= limit) break;
      }
      return out;
    },
  };
}

function strip(e: Entry): SearchResult {
  return { label: e.label, sublabel: e.sublabel, coord: e.coord, cell: e.cell, kind: e.kind };
}
