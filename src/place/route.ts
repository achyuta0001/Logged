// Offline, flood-aware routing on the OSM road network in the pincode pack's osm.geojson.
//
// Graph: OSM ways share exact node coordinates at junctions (rounded to 1e-6 deg by the data build),
// so vertices are keyed by rounded coordinate; a vertex becomes a graph node where a way ends or where
// two ways (or one way twice) meet. Each edge keeps its polyline plus the grid cells it crosses
// (sampled every 0.4 cell) with the length inside each, so a depth grid can be applied per hour.
//
// Search: A* (single target) / Dijkstra (nearest of several) with cost = length x wetness penalty.
// An edge is impassable for a mode when any cell on it is deeper than the mode's limit.
import type { OsmProps, TerrainMeta } from '../types.ts';
import { THRESHOLDS } from '../impact.ts';
import { cellAt, M_PER_DEG_LAT, mPerDegLng, type LngLat } from './geo.ts';

export type { LngLat } from './geo.ts';
export type TravelMode = 'walk' | 'two_wheeler' | 'car';
export type NearestTarget = 'metro' | 'hospital' | 'bus_stop' | 'main_road';
type RoadFC = GeoJSON.FeatureCollection<GeoJSON.Geometry | null, OsmProps>;

export interface ModeSpec {
  label: string;
  /** "on foot", "by two-wheeler", ... */
  by: string;
  /** impassable above this depth (m) */
  maxDepthM: number;
  /** dry-road speed */
  kmh: number;
}

export const MODES: Record<TravelMode, ModeSpec> = {
  // knee-deep moving water knocks adults over; THRESHOLDS.pedestrian (0.15) is where wading starts to hurt
  walk: { label: 'Walk', by: 'on foot', maxDepthM: 0.3, kmh: 4.5 },
  two_wheeler: { label: 'Two-wheeler', by: 'by two-wheeler', maxDepthM: THRESHOLDS.twoWheeler, kmh: 18 },
  car: { label: 'Car', by: 'by car', maxDepthM: THRESHOLDS.car, kmh: 15 },
};

/** Water at or above this depth counts as "wet" (ankle-deep; same as the facility threshold). */
export const WET_M = THRESHOLDS.facility;

const F_NO_WALK = 1; // motorway / motorway_link / flyovers
const F_MAIN = 2; // trunk, primary, secondary, tertiary (+ links)
const F_TRUNK = 4; // at-grade trunk (Mysuru Road, ORR): footpaths exist, but walking there is discouraged
const F_ELEVATED = 8; // flyover / bridge: the DEM under it is not the road surface, so treat as dry
const WALK_TRUNK_COST = 1.3;
const SNAP_NODE_M = 4;
const BUCKET_M = 120;

export interface GraphStats {
  nodes: number;
  edges: number;
  components: number;
  /** nodes in the largest component */
  largest: number;
  /** node counts of the largest components, descending */
  componentSizes: number[];
  /** dead-end nodes merged into a node of another component within SNAP_NODE_M */
  snapped: number;
  lengthKm: number;
  buildMs: number;
}

interface EdgeState {
  cost: Float64Array; // Infinity = impassable / not allowed
}

export interface RoadGraph {
  readonly meta: TerrainMeta;
  readonly n: number;
  readonly m: number;
  readonly kx: number;
  readonly nodeLng: Float64Array;
  readonly nodeLat: Float64Array;
  readonly adjOff: Int32Array;
  readonly adjEdge: Int32Array;
  readonly eA: Int32Array;
  readonly eB: Int32Array;
  readonly eLen: Float64Array;
  readonly eFlags: Uint8Array;
  readonly eRoad: Int32Array;
  readonly eGeoOff: Int32Array;
  readonly eGeo: Float64Array;
  readonly eCellOff: Int32Array;
  readonly eCell: Int32Array;
  readonly eCellLen: Float64Array;
  readonly roads: { name: string; highway: string }[];
  /** connected-component root per node: all roads, and walkable roads only */
  readonly compAll: Int32Array;
  readonly compWalk: Int32Array;
  readonly mainAll: number;
  readonly mainWalk: number;
  readonly stats: GraphStats;
  readonly _buckets: Map<number, number[]>;
  readonly _bucket0: LngLat;
  readonly _wet: WeakMap<Float32Array, Partial<Record<TravelMode, EdgeState>>>;
  readonly _dry: Partial<Record<TravelMode, EdgeState>>;
  readonly _poi: Map<string, { name: string; coord: LngLat; snap: Snap }[]>;
  readonly _main: Partial<Record<TravelMode, Uint8Array>>;
}

/** A point snapped onto an edge: `t` metres from the edge's A end. */
export interface Snap {
  e: number;
  t: number;
  p: LngLat;
  distM: number;
}

export type SegState = 'dry' | 'wet' | 'blocked';
export interface RouteSegment {
  state: SegState;
  coords: LngLat[];
}
export interface RouteBlock {
  coord: LngLat;
  depthM: number;
  roadName: string;
}
export interface RouteResult {
  /** a passable path exists for this mode with this water */
  ok: boolean;
  mode: TravelMode;
  /** the passable path when ok, otherwise the usual dry-weather path (with its blockage) */
  coords: LngLat[];
  /** coords split into runs of dry / wet-but-passable / impassable */
  segments: RouteSegment[];
  lengthM: number;
  /** travel time with this water (wet stretches are slower) */
  minutes: number;
  /** travel time on a dry day */
  dryMinutes: number;
  maxDepthM: number;
  /** metres with water >= WET_M */
  wetLengthM: number;
  /** first impassable point on the usual (dry-weather) route at this hour, if any */
  blocked?: RouteBlock;
  /** the usual (dry-weather) route, set when `coords` is a detour around a blockage */
  usual?: { coords: LngLat[]; segments: RouteSegment[]; lengthM: number; minutes: number };
  /** named roads along the path, most metres first */
  via: string[];
  /** metres from the query points to the road network */
  snapM: [number, number];
  error?: 'off-network' | 'no-path';
}

export interface NearestResult {
  target: { name: string; kind: NearestTarget; coord: LngLat };
  route: RouteResult;
  /** the target you would normally go to, when the water sends you to another one */
  usualTarget?: { name: string; coord: LngLat };
  candidates: number;
}

// --------------------------------------------------------------------------- build

function flagsFor(hw: string, name: string): number {
  let f = 0;
  const elevated = /flyover|bridge|overpass|elevated/i.test(name);
  if (/^motorway/.test(hw) || (elevated && /^(trunk|primary|secondary)/.test(hw))) f |= F_NO_WALK;
  if (/^(trunk|primary|secondary|tertiary)/.test(hw)) f |= F_MAIN;
  if (/^trunk/.test(hw)) f |= F_TRUNK;
  if (elevated) f |= F_ELEVATED;
  return f;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function makeUF(n: number) {
  const p = new Int32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  const find = (x: number) => {
    while (p[x] !== x) {
      p[x] = p[p[x]];
      x = p[x];
    }
    return x;
  };
  return { find, union: (a: number, b: number) => void (p[find(a)] = find(b)) };
}

export function buildRoadGraph(osm: RoadFC, meta: TerrainMeta): RoadGraph {
  const t0 = now();
  const lat0 = (meta.bbox[1] + meta.bbox[3]) / 2;
  const KX = mPerDegLng(lat0);
  const KY = M_PER_DEG_LAT;
  const step = Math.max(1, meta.cellSizeM * 0.4);

  const roads: { name: string; highway: string }[] = [];
  const roadFlags: number[] = [];
  const lines: { cs: GeoJSON.Position[]; road: number }[] = [];
  for (const f of osm.features) {
    const p = f.properties;
    const g = f.geometry;
    if (!p || p.kind !== 'road' || !g) continue;
    const ls = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    const hw = p.highway ?? 'road';
    const r = roads.push({ name: p.name ?? '', highway: hw }) - 1;
    roadFlags.push(flagsFor(hw, p.name ?? ''));
    for (const cs of ls) if (cs.length >= 2) lines.push({ cs, road: r });
  }

  // vertex keys: offset micro-degrees packed into one safe integer (< 2^53)
  const b0 = lines.length ? lines[0].cs[0] : [0, 0];
  const bx = Math.round(b0[0] * 1e6), by = Math.round(b0[1] * 1e6);
  const key = (c: GeoJSON.Position) => (Math.round(c[0] * 1e6) - bx + 33554432) * 67108864 + (Math.round(c[1] * 1e6) - by + 33554432);
  const count = new Map<number, number>();
  for (const { cs } of lines) for (const c of cs) {
    const k = key(c);
    count.set(k, (count.get(k) ?? 0) + 1);
  }

  const nodeOf = new Map<number, number>();
  const lng: number[] = [], lat: number[] = [];
  const node = (c: GeoJSON.Position) => {
    const k = key(c);
    let i = nodeOf.get(k);
    if (i === undefined) {
      i = lng.length;
      nodeOf.set(k, i);
      lng.push(c[0]);
      lat.push(c[1]);
    }
    return i;
  };

  const eA: number[] = [], eB: number[] = [], eLen: number[] = [], eFlags: number[] = [], eRoad: number[] = [];
  const eGeoOff: number[] = [0], eGeo: number[] = [];
  const eCellOff: number[] = [0], eCell: number[] = [], eCellLen: number[] = [];

  const addEdge = (cs: GeoJSON.Position[], i0: number, i1: number, road: number) => {
    const flags = roadFlags[road];
    let total = 0, last = -2;
    for (let k = i0; k < i1; k++) {
      const x0 = cs[k][0], y0 = cs[k][1], x1 = cs[k + 1][0], y1 = cs[k + 1][1];
      const L = Math.hypot((x1 - x0) * KX, (y1 - y0) * KY);
      if (!(L > 0)) continue;
      const pieces = Math.max(1, Math.ceil(L / step));
      const pl = L / pieces;
      for (let j = 0; j < pieces; j++) {
        const t = (j + 0.5) / pieces;
        // elevated decks: the DEM below is a valley floor, not the road surface
        const c = flags & F_ELEVATED ? -1 : cellAt(meta, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
        if (c === last) eCellLen[eCellLen.length - 1] += pl;
        else {
          eCell.push(c);
          eCellLen.push(pl);
          last = c;
        }
      }
      total += L;
    }
    if (!(total > 0)) {
      eCell.length = eCellOff[eCellOff.length - 1];
      eCellLen.length = eCell.length;
      return;
    }
    for (let k = i0; k <= i1; k++) eGeo.push(cs[k][0], cs[k][1]);
    eGeoOff.push(eGeo.length);
    eCellOff.push(eCell.length);
    eA.push(node(cs[i0]));
    eB.push(node(cs[i1]));
    eLen.push(total);
    eFlags.push(flags);
    eRoad.push(road);
  };

  for (const { cs, road } of lines) {
    const at: number[] = [];
    for (let i = 0; i < cs.length; i++) if (i === 0 || i === cs.length - 1 || (count.get(key(cs[i])) ?? 0) > 1) at.push(i);
    for (let k = 0; k + 1 < at.length; k++) {
      const i0 = at[k], i1 = at[k + 1];
      if (key(cs[i0]) !== key(cs[i1])) addEdge(cs, i0, i1, road);
      else if (i1 - i0 >= 2) {
        // closed loop between one node: split it in the middle so it can be routed in both directions
        const mid = (i0 + i1) >> 1;
        addEdge(cs, i0, mid, road);
        addEdge(cs, mid, i1, road);
      }
    }
  }

  const n = lng.length, m = eA.length;
  // ---- snap near-coincident dead ends that belong to different components
  const deg = new Int32Array(n);
  for (let e = 0; e < m; e++) {
    deg[eA[e]]++;
    deg[eB[e]]++;
  }
  const uf0 = makeUF(n);
  for (let e = 0; e < m; e++) uf0.union(eA[e], eB[e]);
  const cellKey = (i: number, dx = 0, dy = 0) => (Math.floor(((lng[i] - b0[0]) * KX) / SNAP_NODE_M) + dx + 1e6) * 4e6 + Math.floor(((lat[i] - b0[1]) * KY) / SNAP_NODE_M) + dy + 1e6;
  const hash = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const k = cellKey(i);
    const a = hash.get(k);
    if (a) a.push(i);
    else hash.set(k, [i]);
  }
  const remap = new Int32Array(n);
  for (let i = 0; i < n; i++) remap[i] = i;
  let snapped = 0;
  for (let i = 0; i < n; i++) {
    if (deg[i] !== 1) continue;
    let best = -1, bestD = SNAP_NODE_M;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of hash.get(cellKey(i, dx, dy)) ?? []) {
          if (j === i || uf0.find(j) === uf0.find(i)) continue;
          const d = Math.hypot((lng[j] - lng[i]) * KX, (lat[j] - lat[i]) * KY);
          if (d <= bestD) {
            bestD = d;
            best = j;
          }
        }
    if (best >= 0) {
      remap[i] = remap[best];
      uf0.union(i, best);
      snapped++;
    }
  }
  if (snapped) for (let e = 0; e < m; e++) {
    eA[e] = remap[eA[e]];
    eB[e] = remap[eB[e]];
  }

  // ---- adjacency (CSR) and components
  const adjCount = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) {
    if (eA[e] === eB[e]) continue;
    adjCount[eA[e] + 1]++;
    adjCount[eB[e] + 1]++;
  }
  for (let i = 0; i < n; i++) adjCount[i + 1] += adjCount[i];
  const adjOff = Int32Array.from(adjCount);
  const fill = Int32Array.from(adjCount);
  const adjEdge = new Int32Array(adjOff[n]);
  for (let e = 0; e < m; e++) {
    if (eA[e] === eB[e]) continue;
    adjEdge[fill[eA[e]]++] = e;
    adjEdge[fill[eB[e]]++] = e;
  }
  const comps = (walkOnly: boolean) => {
    const uf = makeUF(n);
    for (let e = 0; e < m; e++) if (!(walkOnly && eFlags[e] & F_NO_WALK)) uf.union(eA[e], eB[e]);
    const comp = new Int32Array(n);
    const size = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      comp[i] = uf.find(i);
      if (adjOff[i + 1] > adjOff[i]) size.set(comp[i], (size.get(comp[i]) ?? 0) + 1);
    }
    let main = -1, best = -1;
    for (const [r, s] of size) if (s > best) {
      best = s;
      main = r;
    }
    return { comp, main, sizes: [...size.values()].sort((a, b) => b - a) };
  };
  const all = comps(false);
  const walk = comps(true);

  // ---- spatial buckets over edge segments (for snapping points to the network)
  const bucket0: LngLat = [meta.bbox[0], meta.bbox[1]];
  const buckets = new Map<number, number[]>();
  const geoOff = Int32Array.from(eGeoOff);
  const geo = Float64Array.from(eGeo);
  for (let e = 0; e < m; e++) {
    for (let k = geoOff[e]; k + 2 < geoOff[e + 1]; k += 2) {
      const xa = ((geo[k] - bucket0[0]) * KX) / BUCKET_M, ya = ((geo[k + 1] - bucket0[1]) * KY) / BUCKET_M;
      const xb = ((geo[k + 2] - bucket0[0]) * KX) / BUCKET_M, yb = ((geo[k + 3] - bucket0[1]) * KY) / BUCKET_M;
      for (let x = Math.floor(Math.min(xa, xb)); x <= Math.floor(Math.max(xa, xb)); x++)
        for (let y = Math.floor(Math.min(ya, yb)); y <= Math.floor(Math.max(ya, yb)); y++) {
          const bk = bKey(x, y);
          const arr = buckets.get(bk);
          if (!arr) buckets.set(bk, [e]);
          else if (arr[arr.length - 1] !== e) arr.push(e);
        }
    }
  }

  let lengthM = 0;
  for (const l of eLen) lengthM += l;
  const live = all.sizes.reduce((a, b) => a + b, 0);
  return {
    meta,
    n,
    m,
    kx: KX,
    nodeLng: Float64Array.from(lng),
    nodeLat: Float64Array.from(lat),
    adjOff,
    adjEdge,
    eA: Int32Array.from(eA),
    eB: Int32Array.from(eB),
    eLen: Float64Array.from(eLen),
    eFlags: Uint8Array.from(eFlags),
    eRoad: Int32Array.from(eRoad),
    eGeoOff: geoOff,
    eGeo: geo,
    eCellOff: Int32Array.from(eCellOff),
    eCell: Int32Array.from(eCell),
    eCellLen: Float64Array.from(eCellLen),
    roads,
    compAll: all.comp,
    compWalk: walk.comp,
    mainAll: all.main,
    mainWalk: walk.main,
    stats: {
      nodes: live,
      edges: m,
      components: all.sizes.length,
      largest: all.sizes[0] ?? 0,
      componentSizes: all.sizes.slice(0, 8),
      snapped,
      lengthKm: Math.round(lengthM / 100) / 10,
      buildMs: Math.round(now() - t0),
    },
    _buckets: buckets,
    _bucket0: bucket0,
    _wet: new WeakMap(),
    _dry: {},
    _poi: new Map(),
    _main: {},
  };
}

const bKey = (x: number, y: number) => (x + 4096) * 8192 + (y + 4096);

// --------------------------------------------------------------------------- per-hour edge costs

const allowed = (g: RoadGraph, e: number, mode: TravelMode) => !(mode === 'walk' && g.eFlags[e] & F_NO_WALK);

function penalty(d: number, thr: number): number {
  if (d < WET_M) return 1;
  const r = d / thr;
  return 1.5 + 6 * r * r;
}
function slowdown(d: number, thr: number): number {
  if (d < WET_M) return 1;
  return Math.max(0.3, 1 - 0.6 * Math.min(1, d / thr));
}

function edgeState(g: RoadGraph, depth: Float32Array | null, mode: TravelMode): EdgeState {
  let bag: Partial<Record<TravelMode, EdgeState>>;
  if (depth) {
    bag = g._wet.get(depth) ?? {};
    g._wet.set(depth, bag);
  } else bag = g._dry;
  const hit = bag[mode];
  if (hit) return hit;
  const thr = MODES[mode].maxDepthM;
  const cost = new Float64Array(g.m);
  for (let e = 0; e < g.m; e++) {
    if (!allowed(g, e, mode)) {
      cost[e] = Infinity;
      continue;
    }
    const k = mode === 'walk' && g.eFlags[e] & F_TRUNK ? WALK_TRUNK_COST : 1;
    if (!depth) {
      cost[e] = g.eLen[e] * k;
      continue;
    }
    let c = 0;
    for (let j = g.eCellOff[e]; j < g.eCellOff[e + 1]; j++) {
      const cell = g.eCell[j];
      const d = cell >= 0 ? depth[cell] : 0;
      if (d > thr) {
        c = Infinity;
        break;
      }
      c += g.eCellLen[j] * penalty(d, thr);
    }
    cost[e] = c * k;
  }
  const st = { cost };
  bag[mode] = st;
  return st;
}

/** cost of travelling along edge e from ta to tb (metres from A); Infinity if impassable */
function pieceCost(g: RoadGraph, depth: Float32Array | null, mode: TravelMode, e: number, ta: number, tb: number): number {
  if (!allowed(g, e, mode)) return Infinity;
  const k = mode === 'walk' && g.eFlags[e] & F_TRUNK ? WALK_TRUNK_COST : 1;
  const lo = Math.min(ta, tb), hi = Math.max(ta, tb);
  if (!depth) return (hi - lo) * k;
  const thr = MODES[mode].maxDepthM;
  let c = 0, pos = 0;
  for (let j = g.eCellOff[e]; j < g.eCellOff[e + 1]; j++) {
    const a = pos, b = pos + g.eCellLen[j];
    pos = b;
    const l = Math.min(b, hi) - Math.max(a, lo);
    if (l <= 0 && !(lo === hi && lo >= a && lo <= b)) continue;
    const cell = g.eCell[j];
    const d = cell >= 0 ? depth[cell] : 0;
    if (d > thr) return Infinity;
    c += Math.max(0, l) * penalty(d, thr);
  }
  return c * k;
}

// --------------------------------------------------------------------------- snapping

/**
 * Nearest point on the routable network (largest connected component for the mode).
 * `accept` can narrow the candidate edges (e.g. named roads only).
 */
export function snapPoint(g: RoadGraph, p: LngLat, mode: TravelMode, maxM = 600, accept?: (e: number) => boolean): Snap | null {
  const KX = g.kx, KY = M_PER_DEG_LAT;
  const comp = mode === 'walk' ? g.compWalk : g.compAll;
  const main = mode === 'walk' ? g.mainWalk : g.mainAll;
  const qx = ((p[0] - g._bucket0[0]) * KX) / BUCKET_M, qy = ((p[1] - g._bucket0[1]) * KY) / BUCKET_M;
  const cx = Math.floor(qx), cy = Math.floor(qy);
  const seen = new Set<number>();
  let best = null as Snap | null;
  const R = Math.ceil(maxM / BUCKET_M) + 1;
  for (let r = 0; r <= R; r++) {
    for (let x = cx - r; x <= cx + r; x++)
      for (let y = cy - r; y <= cy + r; y++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
        const list = g._buckets.get(bKey(x, y));
        if (!list) continue;
        for (const e of list) {
          if (seen.has(e)) continue;
          seen.add(e);
          if (!allowed(g, e, mode) || comp[g.eA[e]] !== main || (accept && !accept(e))) continue;
          let pos = 0;
          for (let k = g.eGeoOff[e]; k + 2 < g.eGeoOff[e + 1]; k += 2) {
            const ax = (g.eGeo[k] - p[0]) * KX, ay = (g.eGeo[k + 1] - p[1]) * KY;
            const bx = (g.eGeo[k + 2] - p[0]) * KX, by = (g.eGeo[k + 3] - p[1]) * KY;
            const dx = bx - ax, dy = by - ay;
            const L2 = dx * dx + dy * dy;
            const L = Math.sqrt(L2);
            const u = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
            const d = Math.hypot(ax + u * dx, ay + u * dy);
            if (d <= maxM && (!best || d < best.distM)) {
              best = {
                e,
                t: Math.min(g.eLen[e], pos + u * L),
                p: [g.eGeo[k] + (g.eGeo[k + 2] - g.eGeo[k]) * u, g.eGeo[k + 1] + (g.eGeo[k + 3] - g.eGeo[k + 1]) * u],
                distM: d,
              };
            }
            pos += L;
          }
        }
      }
    // everything in ring r+1 is at least r bucket-widths away
    if (best && best.distM <= r * BUCKET_M) break;
  }
  return best;
}

/** Name of the road at a point (or the nearest named road within maxM). */
export function roadNameAt(g: RoadGraph, p: LngLat, maxM = 80): { name: string; distM: number } | null {
  const s = snapPoint(g, p, 'car', maxM, (e) => !!g.roads[g.eRoad[e]].name);
  return s ? { name: g.roads[g.eRoad[s.e]].name, distM: s.distM } : null;
}

// --------------------------------------------------------------------------- search

class Heap {
  private k = new Float64Array(1024);
  private v = new Int32Array(1024);
  size = 0;
  push(key: number, val: number) {
    if (this.size === this.k.length) {
      const k2 = new Float64Array(this.size * 2), v2 = new Int32Array(this.size * 2);
      k2.set(this.k);
      v2.set(this.v);
      this.k = k2;
      this.v = v2;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p];
      this.v[i] = this.v[p];
      i = p;
    }
    this.k[i] = key;
    this.v[i] = val;
  }
  topKey() {
    return this.k[0];
  }
  pop(): number {
    const top = this.v[0];
    const key = this.k[--this.size], val = this.v[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c];
      this.v[i] = this.v[c];
      i = c;
    }
    this.k[i] = key;
    this.v[i] = val;
    return top;
  }
}

interface Piece {
  e: number;
  t0: number;
  t1: number;
}
interface Found {
  pieces: Piece[];
  cost: number;
  /** index into goals, or -1 when a goal node was reached */
  goal: number;
  /** goal node reached (main-road search) */
  node: number;
}

/**
 * Shortest path from a snapped source to the cheapest of `goals` (snapped points) or of `goalNodes`.
 * With one goal and `aim`, runs A* (straight-line metres never overestimate the cost).
 */
function search(
  g: RoadGraph,
  depth: Float32Array | null,
  mode: TravelMode,
  src: Snap,
  goals: Snap[],
  goalNodes: Uint8Array | null,
  aim: LngLat | null,
): Found | null {
  const st = edgeState(g, depth, mode);
  const n = g.n, KX = g.kx, KY = M_PER_DEG_LAT;
  const dist = new Float64Array(n).fill(Infinity);
  const prevE = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new Heap();
  const h = aim ? (u: number) => Math.hypot((g.nodeLng[u] - aim[0]) * KX, (g.nodeLat[u] - aim[1]) * KY) : () => 0;

  const L = g.eLen[src.e];
  for (const [u, c] of [
    [g.eA[src.e], pieceCost(g, depth, mode, src.e, src.t, 0)],
    [g.eB[src.e], pieceCost(g, depth, mode, src.e, src.t, L)],
  ] as const) {
    if (c < dist[u]) {
      dist[u] = c;
      prevE[u] = -2;
      heap.push(c + h(u), u);
    }
  }

  // goals hang off the two end nodes of their edge
  const attach = new Map<number, { k: number; c: number }[]>();
  let bestCost = Infinity, bestGoal = -1, bestVia = -1, bestNode = -1;
  goals.forEach((s, k) => {
    const Lk = g.eLen[s.e];
    const ends: [number, number][] = [
      [g.eA[s.e], pieceCost(g, depth, mode, s.e, 0, s.t)],
      [g.eB[s.e], pieceCost(g, depth, mode, s.e, Lk, s.t)],
    ];
    for (const [u, c] of ends) {
      if (!Number.isFinite(c)) continue;
      const a = attach.get(u);
      if (a) a.push({ k, c });
      else attach.set(u, [{ k, c }]);
    }
    if (s.e === src.e) {
      const c = pieceCost(g, depth, mode, s.e, src.t, s.t);
      if (c < bestCost) {
        bestCost = c;
        bestGoal = k;
        bestVia = -1;
      }
    }
  });

  while (heap.size) {
    if (heap.topKey() >= bestCost) break;
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    const du = dist[u];
    const at = attach.get(u);
    if (at)
      for (const { k, c } of at)
        if (du + c < bestCost) {
          bestCost = du + c;
          bestGoal = k;
          bestVia = u;
        }
    if (goalNodes && goalNodes[u] && du < bestCost) {
      bestCost = du;
      bestGoal = -1;
      bestNode = u;
      bestVia = u;
    }
    for (let j = g.adjOff[u]; j < g.adjOff[u + 1]; j++) {
      const e = g.adjEdge[j];
      const c = st.cost[e];
      if (c === Infinity) continue;
      const v = g.eA[e] === u ? g.eB[e] : g.eA[e];
      const nd = du + c;
      if (nd < dist[v]) {
        dist[v] = nd;
        prevE[v] = e;
        heap.push(nd + h(v), v);
      }
    }
  }
  if (!Number.isFinite(bestCost)) return null;

  const pieces: Piece[] = [];
  if (bestGoal >= 0) {
    const s = goals[bestGoal];
    if (bestVia < 0) return { pieces: [{ e: s.e, t0: src.t, t1: s.t }], cost: bestCost, goal: bestGoal, node: -1 };
    pieces.push({ e: s.e, t0: bestVia === g.eA[s.e] ? 0 : g.eLen[s.e], t1: s.t });
  }
  let u = bestVia;
  for (let guard = 0; guard <= n; guard++) {
    const e = prevE[u];
    if (e === -2) {
      pieces.push({ e: src.e, t0: src.t, t1: u === g.eA[src.e] ? 0 : L });
      break;
    }
    if (e < 0) return null;
    const v = g.eA[e] === u ? g.eB[e] : g.eA[e];
    pieces.push({ e, t0: v === g.eA[e] ? 0 : g.eLen[e], t1: v === g.eA[e] ? g.eLen[e] : 0 });
    u = v;
  }
  pieces.reverse();
  return { pieces, cost: bestCost, goal: bestGoal, node: bestNode };
}

// --------------------------------------------------------------------------- path evaluation

/** points of edge e between positions a and b (metres from A), in the a -> b direction */
function subLine(g: RoadGraph, e: number, a: number, b: number): LngLat[] {
  if (a > b) return subLine(g, e, b, a).reverse();
  const out: LngLat[] = [];
  const KX = g.kx, KY = M_PER_DEG_LAT;
  let pos = 0;
  const o0 = g.eGeoOff[e], o1 = g.eGeoOff[e + 1];
  for (let k = o0; k + 2 < o1; k += 2) {
    const x0 = g.eGeo[k], y0 = g.eGeo[k + 1], x1 = g.eGeo[k + 2], y1 = g.eGeo[k + 3];
    const L = Math.hypot((x1 - x0) * KX, (y1 - y0) * KY);
    const s0 = pos, s1 = pos + L;
    pos = s1;
    if (s1 < a || L <= 0) continue;
    if (!out.length) {
      const u = Math.min(1, Math.max(0, (a - s0) / L));
      out.push([x0 + (x1 - x0) * u, y0 + (y1 - y0) * u]);
    }
    if (s1 >= b) {
      const u = Math.min(1, Math.max(0, (b - s0) / L));
      out.push([x0 + (x1 - x0) * u, y0 + (y1 - y0) * u]);
      return out;
    }
    out.push([x1, y1]);
  }
  if (!out.length) out.push([g.eGeo[o1 - 2], g.eGeo[o1 - 1]]);
  return out;
}

/** cell runs of a piece in travel order: [cell, from, to] with positions in metres from A */
function pieceRuns(g: RoadGraph, pc: Piece): [number, number, number][] {
  const lo = Math.min(pc.t0, pc.t1), hi = Math.max(pc.t0, pc.t1);
  const runs: [number, number, number][] = [];
  let pos = 0;
  for (let j = g.eCellOff[pc.e]; j < g.eCellOff[pc.e + 1]; j++) {
    const a = pos, b = pos + g.eCellLen[j];
    pos = b;
    const x = Math.max(a, lo), y = Math.min(b, hi);
    if (y > x) runs.push([g.eCell[j], x, y]);
  }
  if (pc.t0 > pc.t1) {
    runs.reverse();
    for (const r of runs) [r[1], r[2]] = [r[2], r[1]];
  }
  return runs;
}

function nameOf(g: RoadGraph, e: number, p: LngLat): string {
  const r = g.roads[g.eRoad[e]];
  if (r.name) return r.name;
  const near = roadNameAt(g, p, 90);
  const what = r.highway === 'service' ? 'service lane' : /^(motorway|trunk|primary|secondary|tertiary)/.test(r.highway) ? 'main road' : 'side street';
  return near ? `a ${what} off ${near.name}` : `an unnamed ${what}`;
}

function pushPts(dst: LngLat[], pts: LngLat[]) {
  for (const p of pts) {
    const l = dst[dst.length - 1];
    if (l && Math.abs(l[0] - p[0]) < 1e-9 && Math.abs(l[1] - p[1]) < 1e-9) continue;
    dst.push(p);
  }
}

interface PathEval {
  coords: LngLat[];
  segments: RouteSegment[];
  lengthM: number;
  minutes: number;
  dryMinutes: number;
  maxDepthM: number;
  wetLengthM: number;
  blocked?: RouteBlock;
  via: string[];
}

function evalPath(g: RoadGraph, pieces: Piece[], depth: Float32Array | null, mode: TravelMode): PathEval {
  const spec = MODES[mode];
  const v = spec.kmh / 3.6, thr = spec.maxDepthM;
  const coords: LngLat[] = [];
  const segments: RouteSegment[] = [];
  let cur = null as RouteSegment | null;
  let len = 0, secs = 0, base = 0, maxD = 0, wet = 0;
  let blocked: RouteBlock | undefined;
  let inFirst = false;
  const byRoad = new Map<string, number>();
  for (const pc of pieces) {
    const road = g.roads[g.eRoad[pc.e]].name;
    for (const [cell, a, b] of pieceRuns(g, pc)) {
      const l = Math.abs(b - a);
      const d = depth && cell >= 0 ? depth[cell] : 0;
      const state: SegState = d > thr ? 'blocked' : d >= WET_M ? 'wet' : 'dry';
      const pts = subLine(g, pc.e, a, b);
      pushPts(coords, pts);
      if (!cur || cur.state !== state) {
        const prev: RouteSegment | null = cur;
        cur = { state, coords: prev ? [prev.coords[prev.coords.length - 1]] : [] };
        segments.push(cur);
      }
      pushPts(cur.coords, pts);
      len += l;
      secs += l / (v * slowdown(d, thr));
      base += l / v;
      if (d > maxD) maxD = d;
      if (d >= WET_M) wet += l;
      if (road) byRoad.set(road, (byRoad.get(road) ?? 0) + l);
      if (state === 'blocked') {
        if (!blocked) {
          blocked = { coord: pts[0], depthM: d, roadName: nameOf(g, pc.e, pts[0]) };
          inFirst = true;
        } else if (inFirst && d > blocked.depthM) blocked.depthM = d;
      } else inFirst = false;
    }
  }
  const via = [...byRoad.entries()]
    .filter(([, l]) => l >= 60)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([nm]) => nm);
  return {
    coords,
    segments: segments.filter((s) => s.coords.length >= 2),
    lengthM: len,
    minutes: secs / 60,
    dryMinutes: base / 60,
    maxDepthM: maxD,
    wetLengthM: wet,
    blocked,
    via,
  };
}

function emptyResult(mode: TravelMode, error: RouteResult['error'], a: Snap | null, b: Snap | null): RouteResult {
  return {
    ok: false,
    mode,
    coords: [],
    segments: [],
    lengthM: 0,
    minutes: 0,
    dryMinutes: 0,
    maxDepthM: 0,
    wetLengthM: 0,
    via: [],
    snapM: [a?.distM ?? Infinity, b?.distM ?? Infinity],
    error,
  };
}

function fromSnaps(g: RoadGraph, depth: Float32Array | null, s: Snap, t: Snap, mode: TravelMode): RouteResult {
  const snapM: [number, number] = [s.distM, t.distM];
  const dry = search(g, null, mode, s, [t], null, t.p);
  if (!dry) return emptyResult(mode, 'no-path', s, t);
  const dryEval = evalPath(g, dry.pieces, depth, mode);
  if (!depth) return { ok: true, mode, ...dryEval, snapM };
  const wet = dryEval.blocked ? search(g, depth, mode, s, [t], null, t.p) : dry;
  if (!wet) return { ok: false, mode, ...dryEval, snapM };
  if (wet === dry) {
    // the usual route is passable; still prefer a drier one when the water makes it worthwhile
    const alt = dryEval.wetLengthM > 0 ? search(g, depth, mode, s, [t], null, t.p) : null;
    const ev = alt ? evalPath(g, alt.pieces, depth, mode) : dryEval;
    return { ok: true, mode, ...ev, blocked: undefined, snapM };
  }
  const ev = evalPath(g, wet.pieces, depth, mode);
  return {
    ok: true,
    mode,
    ...ev,
    blocked: dryEval.blocked,
    usual: { coords: dryEval.coords, segments: dryEval.segments, lengthM: dryEval.lengthM, minutes: dryEval.dryMinutes },
    snapM,
  };
}

/**
 * Route between two points for a mode with this hour's water (`depth` = null: a dry day).
 * If no passable path exists, `ok` is false and the result describes the usual dry-weather path
 * and where it is first blocked.
 */
export function route(g: RoadGraph, depth: Float32Array | null, from: LngLat, to: LngLat, mode: TravelMode): RouteResult {
  const s = snapPoint(g, from, mode);
  const t = snapPoint(g, to, mode);
  if (!s || !t) return emptyResult(mode, 'off-network', s, t);
  return fromSnaps(g, depth, s, t, mode);
}

const TARGET_KIND: Record<Exclude<NearestTarget, 'main_road'>, string> = { metro: 'metro', hospital: 'hospital', bus_stop: 'bus_stop' };

function candidates(g: RoadGraph, osm: RoadFC, target: Exclude<NearestTarget, 'main_road'>, mode: TravelMode) {
  const key = `${target}|${mode}`;
  const hit = g._poi.get(key);
  if (hit) return hit;
  const out: { name: string; coord: LngLat; snap: Snap }[] = [];
  for (const f of osm.features) {
    const p = f.properties;
    if (!p || p.kind !== TARGET_KIND[target] || f.geometry?.type !== 'Point') continue;
    const coord = f.geometry.coordinates as LngLat;
    const snap = snapPoint(g, coord, mode, 350);
    if (snap) out.push({ name: p.name || '', coord, snap });
  }
  g._poi.set(key, out);
  return out;
}

function mainNodes(g: RoadGraph, mode: TravelMode): Uint8Array {
  const hit = g._main[mode];
  if (hit) return hit;
  const a = new Uint8Array(g.n);
  for (let e = 0; e < g.m; e++)
    if (g.eFlags[e] & F_MAIN && allowed(g, e, mode)) {
      a[g.eA[e]] = 1;
      a[g.eB[e]] = 1;
    }
  g._main[mode] = a;
  return a;
}

const TARGET_NOUN: Record<NearestTarget, string> = { metro: 'metro station', hospital: 'hospital', bus_stop: 'bus stop', main_road: 'main road' };

/**
 * Nearest reachable metro / hospital / bus stop / main road for a mode at this hour.
 * Searches all candidates at once (multi-target Dijkstra). When none is reachable, returns the
 * usual nearest one with `route.ok = false` and its blockage.
 */
export function nearest(g: RoadGraph, depth: Float32Array | null, from: LngLat, target: NearestTarget, mode: TravelMode, osm: RoadFC): NearestResult | null {
  const s = snapPoint(g, from, mode);
  if (!s) return null;
  const pois = target === 'main_road' ? [] : candidates(g, osm, target, mode);
  const goals = pois.map((c) => c.snap);
  const nodes = target === 'main_road' ? mainNodes(g, mode) : null;
  if (target !== 'main_road' && !goals.length) return null;

  const describe = (f: Found): { name: string; coord: LngLat; snap: Snap } => {
    if (f.goal >= 0) {
      const c = pois[f.goal];
      return { name: c.name || `Unnamed ${TARGET_NOUN[target]}`, coord: c.coord, snap: c.snap };
    }
    // main road: the junction node reached; name it after the main road there
    const u = f.node;
    let name = '';
    let edge = -1;
    for (let j = g.adjOff[u]; j < g.adjOff[u + 1]; j++) {
      const e = g.adjEdge[j];
      if (g.eFlags[e] & F_MAIN && allowed(g, e, mode)) {
        edge = e;
        if (g.roads[g.eRoad[e]].name) {
          name = g.roads[g.eRoad[e]].name;
          break;
        }
      }
    }
    const coord: LngLat = [g.nodeLng[u], g.nodeLat[u]];
    const e = edge >= 0 ? edge : f.pieces[f.pieces.length - 1].e;
    const snap: Snap = { e, t: g.eA[e] === u ? 0 : g.eLen[e], p: coord, distM: 0 };
    return { name: name || 'the main road', coord, snap };
  };

  const dryF = search(g, null, mode, s, goals, nodes, null);
  if (!dryF) return null;
  const usual = describe(dryF);
  const wetF = depth ? search(g, depth, mode, s, goals, nodes, null) : dryF;
  if (!wetF) return { target: { name: usual.name, kind: target, coord: usual.coord }, route: fromSnaps(g, depth, s, usual.snap, mode), candidates: goals.length || 1 };
  const best = describe(wetF);
  const r = fromSnaps(g, depth, s, best.snap, mode);
  const res: NearestResult = { target: { name: best.name, kind: target, coord: best.coord }, route: r, candidates: goals.length || 1 };
  const sameTarget = Math.abs(usual.coord[0] - best.coord[0]) < 1e-9 && Math.abs(usual.coord[1] - best.coord[1]) < 1e-9;
  if (!sameTarget && depth) {
    // the water sends you somewhere else: explain why the usual one is out
    const ur = fromSnaps(g, depth, s, usual.snap, mode);
    if (ur.blocked) {
      res.usualTarget = { name: usual.name, coord: usual.coord };
      r.blocked = ur.blocked;
      r.usual = ur.usual ?? { coords: ur.coords, segments: ur.segments, lengthM: ur.lengthM, minutes: ur.dryMinutes };
    }
  }
  return res;
}

/**
 * Cheap yes/no: can `mode` get from `from` to `to` (a point, or the nearest target of a kind) with
 * this water? Used to scan later hours for when a cut-off route opens again.
 */
export function reachable(g: RoadGraph, depth: Float32Array | null, from: LngLat, to: LngLat | NearestTarget, mode: TravelMode, osm?: RoadFC): boolean {
  const s = snapPoint(g, from, mode);
  if (!s) return false;
  if (typeof to === 'string') {
    if (to === 'main_road') return !!search(g, depth, mode, s, [], mainNodes(g, mode), null);
    if (!osm) return false;
    const goals = candidates(g, osm, to, mode).map((c) => c.snap);
    return goals.length > 0 && !!search(g, depth, mode, s, goals, null, null);
  }
  const t = snapPoint(g, to, mode);
  return !!t && !!search(g, depth, mode, s, [t], null, t.p);
}
