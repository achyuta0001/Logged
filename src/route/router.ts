// City-wide car router over the OSM road graph (public/data/roads, built by
// scripts/route/build-graph.mjs, format in ./format.ts). Pure: no DOM, no fetch; runs in node, a
// page or the router worker (./worker.ts). The public entry point is ./index.ts.
//
// Weights: seconds at typical peak-hour speed (./config.ts table, read from the graph header), plus
// SIGNAL_S per mapped traffic signal passed. Search: A* with ALT potentials (landmark lower bounds
// stored in the graph) combined with the straight-line bound at the fastest class speed; settled
// nodes may reopen, so the slightly inconsistent floored bounds still give exact shortest paths.
// Points snap onto the nearest edge (flyover decks and motorways are only taken when nothing else is
// near), and a route starts and ends mid-edge, honouring one-way streets on those edges too.
// Alternatives: the penalty method. Each round multiplies the weight of the edges on the routes found
// so far and searches again; a candidate is kept when at most 75 % of its length is shared with any
// kept route and it takes at most 1.4x the fastest one. `avoid` adds a large time penalty to edges on
// the given OSM ways, so routes go round flooded hotspots whenever a detour exists.
import type { LngLat } from '../commute/spots.ts';
import type { RouteCandidate } from '../commute/types.ts';
import { edgeSpeedMps } from './config.ts';
import { BRIDGE, BWD, FWD, TUNNEL, type RawGraph } from './format.ts';

const M_LAT = 110574;
const mLng = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);
const CELL_M = 250;
/** snapping: extra metres a candidate edge must beat before a deck, motorway or link is chosen */
const SNAP_BIAS_DECK = 60;
const SNAP_BIAS_LINK = 25;

/** Alternatives: at most this share of a candidate's length may be shared with a kept route */
export const MAX_SHARED = 0.75;
/** ... and it may take at most this multiple of the fastest route's time */
export const MAX_STRETCH = 1.4;
/** weight factor added per round to edges on routes found so far */
const PENALTY = 0.5;
const MAX_ROUNDS = 7;
/** default time penalty for an avoided edge: a detour up to this much longer is taken instead */
export const AVOID_PENALTY_S = 3600;

export interface RouteWay {
  /** OSM way id */
  id: number;
  /** index into `line` where the route enters this way */
  i: number;
}

/** A RouteCandidate plus what the hotspot matching needs. */
export interface RoutedCandidate extends RouteCandidate {
  /** OSM ways along the route, in travel order (a way entered twice is listed twice) */
  ways: RouteWay[];
  /** cumulative metres at each line vertex (same length as line) */
  cumM: number[];
}

export interface RouteOptions {
  /** routes wanted, 1–3 (default 3): the fastest, then up to two distinct alternatives */
  alternatives?: number;
  /** OSM way ids to keep off (flooded hotspots); still used when no detour under avoidPenaltyS exists */
  avoid?: Iterable<number>;
  avoidPenaltyS?: number;
}

/** A point snapped onto an edge, `t` metres along the edge's polyline from its first node. */
export interface Snap {
  e: number;
  t: number;
  p: LngLat;
  distM: number;
}

export interface RouteStats {
  /** nodes taken off the heap, summed over every search of the request */
  settled: number;
  searches: number;
  ms: number;
}

interface Piece {
  e: number;
  t0: number;
  t1: number;
}

class Heap {
  k = new Float64Array(4096);
  v = new Int32Array(4096);
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

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Short forms commuters use for the big corridors. */
const SHORT: Record<string, string> = { 'Outer Ring Road': 'ORR', 'Inner Ring Road': 'Inner Ring Road' };

export class Router {
  readonly g: RawGraph;
  readonly n: number;
  readonly m: number;
  /** landmarks */
  readonly K: number;
  readonly kx: number;
  /** seconds per metre along each edge (signals inside the edge spread over its length) */
  readonly spm: Float64Array;
  /** forward arcs of node u: [outOff[u], outOff[u+1]) -> head, edge, along (1 = u -> v of the edge), weight s */
  readonly outOff: Int32Array;
  readonly outHead: Int32Array;
  readonly outEdge: Int32Array;
  readonly outAlong: Uint8Array;
  readonly outW: Float64Array;
  /** landmark lower bounds, node-major: lmN[v * K + l] */
  readonly lmN: Uint16Array;
  /** fastest speed in the table, m/s (straight-line bound) */
  readonly vmax: number;
  private readonly signalS: number;
  // spatial grid over edges
  private readonly gx0: number;
  private readonly gy0: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cellOff: Int32Array;
  private readonly cellEdge: Int32Array;
  // search scratch, reused across queries
  private readonly dist: Float64Array;
  private readonly hv: Float64Array;
  private readonly par: Int32Array;
  private readonly parN: Int32Array;
  private readonly stamp: Uint32Array;
  private gen = 0;
  private readonly heap = new Heap();
  private wayEdges: Map<number, number[]> | null = null;
  lastStats: RouteStats = { settled: 0, searches: 0, ms: 0 };

  constructor(g: RawGraph, opts: { heuristic?: boolean } = {}) {
    this.g = g;
    const n = (this.n = g.header.n), m = (this.m = g.header.m);
    // heuristic: false = plain Dijkstra (tests and the benchmark check A* against it)
    const astar = opts.heuristic ?? true;
    this.K = astar ? g.header.landmarks.length : 0;
    const sp = g.header.speeds;
    this.signalS = sp.signalS;
    this.vmax = astar ? Math.max(...sp.kmh) / 3.6 : Infinity;
    const b = g.header.bbox;
    this.kx = mLng((b[1] + b[3]) / 2);

    // ---- weights and forward arcs
    const spm = (this.spm = new Float64Array(m));
    const outOff = (this.outOff = new Int32Array(n + 1));
    for (let e = 0; e < m; e++) {
      const L = g.eLen[e];
      const base = L / edgeSpeedMps(sp, g.eClass[e], g.eMaxspeed[e]) + g.eSignals[e] * sp.signalS;
      spm[e] = L > 0 ? base / L : 0;
      if (g.eFlags[e] & FWD) outOff[g.eU[e] + 1]++;
      if (g.eFlags[e] & BWD) outOff[g.eV[e] + 1]++;
    }
    for (let i = 0; i < n; i++) outOff[i + 1] += outOff[i];
    const A = outOff[n];
    this.outHead = new Int32Array(A);
    this.outEdge = new Int32Array(A);
    this.outAlong = new Uint8Array(A);
    this.outW = new Float64Array(A);
    const fill = Int32Array.from(outOff);
    for (let e = 0; e < m; e++) {
      const base = g.eLen[e] * spm[e];
      if (g.eFlags[e] & FWD) {
        const j = fill[g.eU[e]]++;
        this.outHead[j] = g.eV[e];
        this.outEdge[j] = e;
        this.outAlong[j] = 1;
        this.outW[j] = base + g.nodeSignal[g.eV[e]] * sp.signalS;
      }
      if (g.eFlags[e] & BWD) {
        const j = fill[g.eV[e]]++;
        this.outHead[j] = g.eU[e];
        this.outEdge[j] = e;
        this.outAlong[j] = 0;
        this.outW[j] = base + g.nodeSignal[g.eU[e]] * sp.signalS;
      }
    }

    this.lmN = g.lm;

    // ---- spatial grid: each edge listed in every cell one of its segments' boxes touches
    this.gx0 = b[0];
    this.gy0 = b[1];
    this.cols = Math.max(1, Math.ceil(((b[2] - b[0]) * this.kx) / CELL_M));
    this.rows = Math.max(1, Math.ceil(((b[3] - b[1]) * M_LAT) / CELL_M));
    const C = this.cols * this.rows;
    const count = new Int32Array(C + 1);
    const last = new Int32Array(C).fill(-1);
    const visit = (fn: (cell: number, e: number) => void) => {
      last.fill(-1);
      for (let e = 0; e < m; e++) {
        for (let k = g.geoOff[e]; k + 1 < g.geoOff[e + 1]; k++) {
          const x0 = this.cx(g.geoLng[k]), x1 = this.cx(g.geoLng[k + 1]);
          const y0 = this.cy(g.geoLat[k]), y1 = this.cy(g.geoLat[k + 1]);
          for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
            for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
              const c = y * this.cols + x;
              if (last[c] === e) continue;
              last[c] = e;
              fn(c, e);
            }
        }
      }
    };
    visit((c) => count[c + 1]++);
    for (let c = 0; c < C; c++) count[c + 1] += count[c];
    this.cellOff = count;
    this.cellEdge = new Int32Array(count[C]);
    const cf = Int32Array.from(count);
    visit((c, e) => (this.cellEdge[cf[c]++] = e));

    this.dist = new Float64Array(n);
    this.hv = new Float64Array(n);
    this.par = new Int32Array(n);
    this.parN = new Int32Array(n);
    this.stamp = new Uint32Array(n);
  }

  private cx(lng: number) {
    return Math.max(0, Math.min(this.cols - 1, Math.floor(((lng - this.gx0) * this.kx) / CELL_M)));
  }
  private cy(lat: number) {
    return Math.max(0, Math.min(this.rows - 1, Math.floor(((lat - this.gy0) * M_LAT) / CELL_M)));
  }

  // ------------------------------------------------------------------------------------ snapping

  /** Nearest point on the network within maxM (decks, motorways and links only when nothing else is near). */
  snap(p: LngLat, maxM = 1500): Snap | null {
    const g = this.g, KX = this.kx;
    const qx = ((p[0] - this.gx0) * KX) / CELL_M, qy = ((p[1] - this.gy0) * M_LAT) / CELL_M;
    const cx = Math.floor(qx), cy = Math.floor(qy);
    const R = Math.ceil((maxM + SNAP_BIAS_DECK) / CELL_M) + 1;
    let best = null as Snap | null, bestScore = Infinity;
    const seen = new Set<number>();
    for (let r = 0; r <= R; r++) {
      for (let x = cx - r; x <= cx + r; x++)
        for (let y = cy - r; y <= cy + r; y++) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
          if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) continue;
          const c = y * this.cols + x;
          for (let j = this.cellOff[c]; j < this.cellOff[c + 1]; j++) {
            const e = this.cellEdge[j];
            if (seen.has(e)) continue;
            seen.add(e);
            const cls = g.header.speeds.classes[g.eClass[e]];
            const bias = g.eFlags[e] & (BRIDGE | TUNNEL) || cls === 'motorway' ? SNAP_BIAS_DECK : cls.endsWith('_link') ? SNAP_BIAS_LINK : 0;
            let pos = 0;
            for (let k = g.geoOff[e]; k + 1 < g.geoOff[e + 1]; k++) {
              const ax = (g.geoLng[k] - p[0]) * KX, ay = (g.geoLat[k] - p[1]) * M_LAT;
              const bx = (g.geoLng[k + 1] - p[0]) * KX, by = (g.geoLat[k + 1] - p[1]) * M_LAT;
              const dx = bx - ax, dy = by - ay;
              const L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
              const u = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
              const d = Math.hypot(ax + u * dx, ay + u * dy);
              if (d <= maxM && d + bias < bestScore) {
                bestScore = d + bias;
                best = {
                  e,
                  t: pos + u * L, // polyline metres, scaled to the stored length below
                  p: [g.geoLng[k] + (g.geoLng[k + 1] - g.geoLng[k]) * u, g.geoLat[k] + (g.geoLat[k + 1] - g.geoLat[k]) * u],
                  distM: d,
                };
              }
              pos += L;
            }
          }
        }
      // everything in ring r+1 is at least r cells away
      if (best && bestScore <= r * CELL_M) break;
    }
    if (best) {
      // polyline metres -> stored edge length (they differ by rounding only)
      const tot = this.polyLen(best.e);
      best.t = tot > 0 ? Math.min(g.eLen[best.e], (best.t / tot) * g.eLen[best.e]) : 0;
    }
    return best;
  }

  private polyLen(e: number): number {
    const g = this.g;
    let s = 0;
    for (let k = g.geoOff[e]; k + 1 < g.geoOff[e + 1]; k++) s += Math.hypot((g.geoLng[k + 1] - g.geoLng[k]) * this.kx, (g.geoLat[k + 1] - g.geoLat[k]) * M_LAT);
    return s;
  }

  // ------------------------------------------------------------------------------------ search

  /** edges carrying any of these OSM way ids */
  edgesOfWays(ids: Iterable<number>): number[] {
    if (!this.wayEdges) {
      const map = new Map<number, number[]>();
      const g = this.g;
      for (let e = 0; e < this.m; e++)
        for (let j = g.wayOff[e]; j < g.wayOff[e + 1]; j++) {
          const id = g.wayId[j];
          const a = map.get(id);
          if (!a) map.set(id, [e]);
          else if (a[a.length - 1] !== e) a.push(e);
        }
      this.wayEdges = map;
    }
    const out: number[] = [];
    for (const id of ids) for (const e of this.wayEdges.get(Number(id)) ?? []) out.push(e);
    return out;
  }

  /**
   * Fastest path between two snapped points. `mult` scales edge weights (alternatives), `avoid`
   * flags edges that cost `avoidS` extra. Returns the pieces in travel order and the weighted cost.
   */
  search(s: Snap, t: Snap, mult: Float32Array | null, avoid: Uint8Array | null, avoidS: number): { pieces: Piece[]; cost: number; settled: number } | null {
    const g = this.g, K = this.K, S = this.signalS;
    const gen = ++this.gen;
    if (gen === 0xffffffff) {
      this.stamp.fill(0);
      this.gen = 1;
    }
    const { dist, hv, par, parN, stamp, lmN, outOff, outHead, outEdge, outW } = this;
    const heap = this.heap;
    heap.size = 0;

    // target: reached from its edge's ends
    const tNode: number[] = [], tCost: number[] = [];
    const Lt = g.eLen[t.e];
    if (g.eFlags[t.e] & FWD) {
      tNode.push(g.eU[t.e]);
      tCost.push(t.t * this.spm[t.e]);
    }
    if (g.eFlags[t.e] & BWD) {
      tNode.push(g.eV[t.e]);
      tCost.push((Lt - t.t) * this.spm[t.e]);
    }
    const tD = new Float64Array(tNode.length * K);
    tNode.forEach((x, a) => {
      for (let l = 0; l < K; l++) tD[a * K + l] = lmN[x * K + l];
    });
    const tx = t.p[0], ty = t.p[1], kx = this.kx, vmax = this.vmax;
    const nT = tNode.length;
    const h = (v: number) => {
      let lb = Infinity;
      for (let a = 0; a < nT; a++) {
        let mx = 0;
        const bv = v * K, ba = a * K;
        for (let l = 0; l < K; l++) {
          const d = tD[ba + l] - lmN[bv + l];
          if (d > mx) mx = d;
          else if (-d > mx) mx = -d;
        }
        if (mx < lb) lb = mx;
      }
      lb -= 1; // bounds are whole seconds rounded down
      const dx = (g.nodeLng[v] - tx) * kx, dy = (g.nodeLat[v] - ty) * M_LAT;
      const eu = Math.sqrt(dx * dx + dy * dy) / vmax;
      return eu > lb ? eu : lb > 0 ? lb : 0;
    };
    const touch = (v: number) => {
      if (stamp[v] !== gen) {
        stamp[v] = gen;
        dist[v] = Infinity;
        hv[v] = h(v);
      }
    };

    // source: leaves along its edge in each allowed direction
    let best = Infinity, bestA = -2;
    const Ls = g.eLen[s.e];
    const starts: [number, number][] = [];
    if (g.eFlags[s.e] & FWD) starts.push([g.eV[s.e], (Ls - s.t) * this.spm[s.e] + g.nodeSignal[g.eV[s.e]] * S]);
    if (g.eFlags[s.e] & BWD) starts.push([g.eU[s.e], s.t * this.spm[s.e] + g.nodeSignal[g.eU[s.e]] * S]);
    for (const [v, c] of starts) {
      touch(v);
      if (c < dist[v]) {
        dist[v] = c;
        par[v] = -1;
        parN[v] = -1;
        heap.push(c + hv[v], v);
      }
    }
    if (s.e === t.e) {
      // straight along the shared edge, when its direction allows
      if (g.eFlags[s.e] & FWD && s.t <= t.t) best = (t.t - s.t) * this.spm[s.e];
      if (g.eFlags[s.e] & BWD && s.t >= t.t) best = Math.min(best, (s.t - t.t) * this.spm[s.e]);
      if (Number.isFinite(best)) bestA = -1;
    }

    let settled = 0;
    while (heap.size) {
      const f = heap.k[0];
      if (f >= best) break;
      const u = heap.pop();
      const gu = dist[u];
      if (f - hv[u] > gu + 1e-7) continue; // stale entry
      settled++;
      for (let a = 0; a < nT; a++)
        if (tNode[a] === u && gu + tCost[a] < best) {
          best = gu + tCost[a];
          bestA = a;
        }
      for (let j = outOff[u]; j < outOff[u + 1]; j++) {
        const e = outEdge[j];
        let w = outW[j];
        if (mult !== null) w *= mult[e];
        if (avoid !== null && avoid[e]) w += avoidS;
        const v = outHead[j];
        const nd = gu + w;
        if (stamp[v] !== gen) touch(v);
        if (nd < dist[v]) {
          dist[v] = nd;
          par[v] = j;
          parN[v] = u;
          heap.push(nd + hv[v], v);
        }
      }
    }
    if (bestA === -2) return null;
    if (bestA === -1) return { pieces: [{ e: s.e, t0: s.t, t1: t.t }], cost: best, settled };

    const pieces: Piece[] = [];
    const x = tNode[bestA];
    pieces.push({ e: t.e, t0: x === g.eU[t.e] ? 0 : Lt, t1: t.t });
    let v = x;
    for (let guard = 0; guard <= this.n; guard++) {
      const j = par[v];
      if (j < 0) break;
      const e = outEdge[j];
      pieces.push(this.outAlong[j] ? { e, t0: 0, t1: g.eLen[e] } : { e, t0: g.eLen[e], t1: 0 });
      v = parN[v];
    }
    // v is now the node the source left by
    pieces.push({ e: s.e, t0: s.t, t1: v === g.eV[s.e] ? Ls : 0 });
    pieces.reverse();
    return { pieces, cost: best, settled };
  }

  // ------------------------------------------------------------------------------------ routes

  /** Fastest route plus up to two distinct alternatives, or [] when a point is off the network. */
  route(from: LngLat, to: LngLat, opts: RouteOptions = {}): RoutedCandidate[] {
    const t0 = now();
    const want = Math.max(1, Math.min(3, opts.alternatives ?? 3));
    const s = this.snap(from), t = this.snap(to);
    this.lastStats = { settled: 0, searches: 0, ms: 0 };
    if (!s || !t) return [];
    let avoid: Uint8Array | null = null;
    const avoidS = opts.avoidPenaltyS ?? AVOID_PENALTY_S;
    if (opts.avoid) {
      const es = this.edgesOfWays(opts.avoid);
      if (es.length) {
        avoid = new Uint8Array(this.m);
        for (const e of es) avoid[e] = 1;
        // the commuter has to leave home and reach work whatever their own street is like
        avoid[s.e] = 0;
        avoid[t.e] = 0;
      }
    }
    const run = (mult: Float32Array | null) => {
      const r = this.search(s, t, mult, avoid, avoidS);
      this.lastStats.searches++;
      if (r) this.lastStats.settled += r.settled;
      return r;
    };
    const first = run(null);
    if (!first) {
      this.lastStats.ms = now() - t0;
      return [];
    }
    const kept: { pieces: Piece[]; cand: RoutedCandidate; edges: Map<number, number> }[] = [];
    const add = (pieces: Piece[]) => {
      const cand = this.candidate(pieces, (['A', 'B', 'C'] as const)[kept.length]);
      kept.push({ pieces, cand, edges: this.edgeLengths(pieces) });
    };
    add(first.pieces);
    if (want > 1) {
      const mult = new Float32Array(this.m).fill(1);
      let last = first.pieces;
      for (let round = 0; round < MAX_ROUNDS && kept.length < want; round++) {
        for (const pc of last) mult[pc.e] *= 1 + PENALTY;
        const r = run(mult);
        if (!r) break;
        last = r.pieces;
        const len = this.piecesLength(r.pieces);
        const dur = this.piecesTime(r.pieces);
        if (dur > MAX_STRETCH * kept[0].cand.durationS) break;
        const mine = this.edgeLengths(r.pieces);
        let shared = 0;
        for (const k of kept) {
          let sh = 0;
          for (const [e, l] of mine) if (k.edges.has(e)) sh += Math.min(l, k.edges.get(e)!);
          shared = Math.max(shared, sh);
        }
        if (len > 0 && shared / len <= MAX_SHARED) add(r.pieces);
      }
    }
    const out = kept.map((k) => k.cand);
    this.describe(out, kept.map((k) => k.pieces));
    this.lastStats.ms = now() - t0;
    return out;
  }

  private piecesLength(pieces: Piece[]) {
    let s = 0;
    for (const p of pieces) s += Math.abs(p.t1 - p.t0);
    return s;
  }

  /** unweighted travel time of pieces (what the commuter would take), s */
  private piecesTime(pieces: Piece[]) {
    const g = this.g;
    let s = 0;
    pieces.forEach((p, i) => {
      s += Math.abs(p.t1 - p.t0) * this.spm[p.e];
      if (i < pieces.length - 1) {
        const node = p.t1 === 0 ? g.eU[p.e] : g.eV[p.e];
        s += g.nodeSignal[node] * this.signalS;
      }
    });
    return s;
  }

  private edgeLengths(pieces: Piece[]) {
    const m = new Map<number, number>();
    for (const p of pieces) m.set(p.e, (m.get(p.e) ?? 0) + Math.abs(p.t1 - p.t0));
    return m;
  }

  /** points of a piece in travel order, each with the polyline segment it ends on */
  private walk(p: Piece, emit: (lng: number, lat: number, seg: number) => void) {
    const g = this.g;
    const o0 = g.geoOff[p.e], o1 = g.geoOff[p.e + 1];
    const tot = this.polyLen(p.e);
    const scale = tot > 0 ? tot / Math.max(1e-9, g.eLen[p.e]) : 1;
    const lo = Math.min(p.t0, p.t1) * scale, hi = Math.max(p.t0, p.t1) * scale;
    const pts: [number, number, number][] = [];
    let pos = 0;
    for (let k = o0; k + 1 < o1; k++) {
      const x0 = g.geoLng[k], y0 = g.geoLat[k], x1 = g.geoLng[k + 1], y1 = g.geoLat[k + 1];
      const L = Math.hypot((x1 - x0) * this.kx, (y1 - y0) * M_LAT);
      const a = pos, b = pos + L;
      pos = b;
      if (b < lo || L <= 0) continue;
      if (!pts.length) {
        const u = Math.min(1, Math.max(0, (lo - a) / L));
        pts.push([x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, k - o0]);
      }
      if (b >= hi) {
        const u = Math.min(1, Math.max(0, (hi - a) / L));
        pts.push([x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, k - o0]);
        break;
      }
      pts.push([x1, y1, k - o0]);
    }
    if (!pts.length) pts.push([g.geoLng[o1 - 1], g.geoLat[o1 - 1], Math.max(0, o1 - o0 - 2)]);
    if (p.t0 > p.t1) {
      // reversed: a point is reached along the segment that ends at the point after it (polyline order)
      const N = pts.length - 1;
      for (let i = N; i >= 0; i--) emit(pts[i][0], pts[i][1], pts[Math.min(N, i + 1)][2]);
    } else for (const q of pts) emit(q[0], q[1], q[2]);
  }

  private wayAt(e: number, seg: number): number {
    const g = this.g;
    let id = g.wayId[g.wayOff[e]];
    for (let j = g.wayOff[e]; j < g.wayOff[e + 1]; j++) {
      if (g.wayAt[j] <= seg) id = g.wayId[j];
      else break;
    }
    return id;
  }

  /** line, cumS, cumM and ways of a path (unweighted times) */
  private candidate(pieces: Piece[], id: RoutedCandidate['id']): RoutedCandidate {
    const g = this.g;
    const line: LngLat[] = [], cumS: number[] = [], cumM: number[] = [], ways: RouteWay[] = [];
    let tS = 0, tM = 0;
    pieces.forEach((p, i) => {
      const spm = this.spm[p.e];
      this.walk(p, (lng, lat, seg) => {
        const prev = line[line.length - 1];
        if (!prev) {
          line.push([lng, lat]);
          cumS.push(0);
          cumM.push(0);
          return;
        }
        const d = Math.hypot((lng - prev[0]) * this.kx, (lat - prev[1]) * M_LAT);
        if (d < 0.01) return;
        const way = this.wayAt(p.e, seg);
        if (!ways.length || ways[ways.length - 1].id !== way) ways.push({ id: way, i: line.length - 1 });
        tM += d;
        tS += d * spm;
        line.push([lng, lat]);
        cumS.push(tS);
        cumM.push(tM);
      });
      if (i < pieces.length - 1) {
        const node = p.t1 === 0 ? g.eU[p.e] : g.eV[p.e];
        if (g.nodeSignal[node]) {
          tS += this.signalS;
          cumS[cumS.length - 1] = tS;
        }
      }
    });
    // polyline metres differ from the stored lengths by rounding only: report the stored ones
    const lengthM = this.piecesLength(pieces);
    const durationS = this.piecesTime(pieces);
    const ks = tS > 0 ? durationS / tS : 1, km = tM > 0 ? lengthM / tM : 1;
    for (let i = 0; i < cumS.length; i++) {
      cumS[i] *= ks;
      cumM[i] *= km;
    }
    return { id, line, lengthM, durationS, cumS, via: '', ways, cumM };
  }

  /** "via ORR and Sarjapur Road": the longest named roads; alternatives name what sets them apart */
  private describe(cands: RoutedCandidate[], paths: Piece[][]) {
    const g = this.g;
    const byName = paths.map((pieces) => {
      const m = new Map<string, number>();
      for (const p of pieces) {
        const ix = g.eName[p.e] >= 0 ? g.eName[p.e] : g.eRef[p.e];
        if (ix < 0) continue;
        const nm = SHORT[g.names[ix]] ?? g.names[ix];
        m.set(nm, (m.get(nm) ?? 0) + Math.abs(p.t1 - p.t0));
      }
      return m;
    });
    cands.forEach((c, i) => {
      const mine = byName[i];
      const others = byName.filter((_, j) => j !== i);
      const score = (nm: string, l: number) => (i === 0 ? l : l - Math.max(0, ...others.map((o) => o.get(nm) ?? 0)));
      const top = [...mine.entries()]
        .filter(([, l]) => l >= Math.min(800, 0.1 * c.lengthM))
        .map(([nm, l]) => [nm, score(nm, l), l] as const)
        .sort((a, b) => b[1] - a[1] || b[2] - a[2])
        .slice(0, 2)
        .map(([nm]) => nm);
      c.via = top.length === 2 ? `via ${top[0]} and ${top[1]}` : top.length === 1 ? `via ${top[0]}` : 'via local roads';
    });
  }
}
