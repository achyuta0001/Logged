/**
 * Upstream inflow (M4): water that runs off land OUTSIDE a pack's grid and drains into it.
 *
 * A pack covers the pincode plus a margin, but a valley like Koramangala–Challaghatta collects runoff
 * from ~100 km² upstream. Each `InflowPoint` (meta.inflow, written by scripts/build-data.mjs from the
 * district-wide 60 m D8 routing of `npm run data:city`) describes the outside catchment of one flow
 * path that crosses into the grid. Its hourly inflow comes from a lumped model that applies the SAME
 * losses as the grid (src/sim/core.ts), so the drain and infiltration controls act on it too:
 *   1. losses: infiltration on the pervious share (the soil store saturates as in core.ts), then storm
 *      drains: capacity x (1 - blockage), 30 % of it everywhere and 70 % where mapped drains serve;
 *   2. tanks: the share of the catchment that drains through a mapped tank fills the tanks' flood
 *      cushion first (the grid's freeboard rule, lakeFreeboardM);
 *   3. routing: a Clark unit hydrograph. The time-area histogram (travel time along the D8 path at
 *      velocity-method speeds) translates the excess, then a linear reservoir (storage ~0.5 x Tc)
 *      attenuates it.
 * The hour's volume enters at a constant rate through that hour at the point's cell (on the pack's own
 * flow path, a few cells inside the edge) and is booked as `inflow` in the water budget.
 */
import type { InflowEdgeRun, InflowPoint, SimParams } from '../types.ts';
import { DEFAULT_PARAMS } from './core.ts';

// the grid's vertical losses (src/sim/core.ts), per unit pervious area
const SOIL_CAP_MM = 100;
const SOIL_SAT_FACTOR = 0.15;
const SOIL_RECOVERY_MM_H = 2;
/** share of drain capacity acting everywhere (unmapped roadside drains), as DRAIN_LOCAL_SHARE in core.ts */
const DRAIN_LOCAL_SHARE = 0.3;
const MAX_BINS = 48;
/** radius the inflow of one point is spread over on the hydraulic grid, m (at least one cell) */
const SPREAD_M = 60;

/** cells within this of one level form a DEM water surface (the 30 m surface model flattens water bodies), m */
const FLAT_EPS_M = 0.01;
/** smallest flat taken for a water body, m² */
const FLAT_MIN_M2 = 1e4;
/** a cut tank's banks along the grid edge, up to this above its level, are closed with it, m */
const TANK_BANK_M = 2;

const clamp01 = (v: number | undefined, d = 0) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v as number)) : d);

/**
 * Inflow edges across tanks cut by the grid edge. Where a closed inflow-edge cell lies on, or next to (along
 * the edge), a water body that the grid edge cuts, that body's whole cut is closed too. A water body is a
 * mapped tank (4-connected lakeMask component) or a DEM water surface: a 4-connected flat of at least
 * FLAT_MIN_M2 within FLAT_EPS_M of one level, a quarter of it interior cells (the surface model flattens
 * water, mapped or not; a strip of one level along a uniform slope is not a flat). Why: the
 * tank's level is the same on both sides of the cut and the land beyond drains in, so water reaching the
 * tank leaves by its outlet, not back across the cut; the district routing marks only the stretch where its
 * flow lines cross straight in (on a tank they run along the cut to the crossing). 560102: the west entry
 * ran into such a tank and 223k+ m³ of the inflow left across its open cut, just past the closed stretch.
 * So are the cut's banks, the edge cells beside it up to TANK_BANK_M above the tank's level, which the tank
 * covers when it runs high. The added cells are closed and reopened with the rest (SimCore.closeEdges /
 * setEdgesClosed).
 */
export function closeAcrossWater(closed: ArrayLike<number>, W: number, H: number, dx: number, z: ArrayLike<number>, lakeMask?: ArrayLike<number>): Int32Array {
  const n = W * H;
  const out = new Set<number>();
  for (let k = 0; k < closed.length; k++) if (closed[k] >= 0 && closed[k] < n) out.add(closed[k]);
  if (!out.size || W < 3 || H < 3) return Int32Array.from(out);
  const onEdge = (i: number) => { const r = (i / W) | 0, c = i - r * W; return r === 0 || c === 0 || r === H - 1 || c === W - 1; };
  const ok = (i: number) => Number.isFinite(z[i]) && z[i] > -1000;
  const seen = new Uint8Array(n), bank = new Uint8Array(n), stamp = new Int32Array(n);
  let id = 0;
  const minCells = Math.max(2, Math.ceil(FLAT_MIN_M2 / (dx * dx)));
  const body: number[] = [];
  for (const c of [...out]) {
    const r0 = (c / W) | 0, c0 = c - r0 * W;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const r = r0 + dr, cc = c0 + dc;
        if (r < 0 || cc < 0 || r >= H || cc >= W) continue;
        const q = r * W + cc;
        if (seen[q] || !onEdge(q) || !ok(q)) continue;
        // grow the water body from q: its lake component, else the flat at q's level
        const lake = !!lakeMask?.[q], level = z[q];
        const inBody = (j: number) => (lake ? !!lakeMask![j] : !lakeMask?.[j] && ok(j) && Math.abs(z[j] - level) <= FLAT_EPS_M);
        body.length = 0;
        body.push(q);
        seen[q] = 1;
        for (let k = 0; k < body.length; k++) {
          const i = body[k], ri = (i / W) | 0, ci = i - ri * W;
          for (const j of [ci + 1 < W ? i + 1 : -1, ci > 0 ? i - 1 : -1, ri + 1 < H ? i + W : -1, ri > 0 ? i - W : -1])
            if (j >= 0 && !seen[j] && inBody(j)) { seen[j] = 1; body.push(j); }
        }
        if (!lake) {
          // a water surface is flat in both directions: a strip of one level along a slope is not one
          id++;
          for (const i of body) stamp[i] = id;
          let interior = 0;
          for (const i of body) {
            const ri = (i / W) | 0, ci = i - ri * W;
            if (ri > 0 && ci > 0 && ri < H - 1 && ci < W - 1 && stamp[i + 1] === id && stamp[i - 1] === id && stamp[i + W] === id && stamp[i - W] === id) interior++;
          }
          if (body.length < minCells || interior * 4 < minCells) continue;
        }
        // the cut, then its banks: edge cells next to it (along the edge) up to TANK_BANK_M above the
        // tank's level; lower ground is an outlet channel, not a bank, and stays open
        let lvl = Infinity;
        const cut: number[] = [];
        for (const i of body) if (onEdge(i)) { cut.push(i); if (z[i] < lvl) lvl = z[i]; }
        for (const i of cut) bank[i] = 1;
        while (cut.length) {
          const i = cut.pop()!, ri = (i / W) | 0, ci = i - ri * W;
          out.add(i);
          for (let er = -1; er <= 1; er++)
            for (let ec = -1; ec <= 1; ec++) {
              const r2 = ri + er, c2 = ci + ec, j = r2 * W + c2;
              if (r2 < 0 || c2 < 0 || r2 >= H || c2 >= W || bank[j] || !onEdge(j) || !ok(j)) continue;
              if (z[j] < lvl - FLAT_EPS_M || z[j] > lvl + TANK_BANK_M) continue;
              bank[j] = 1;
              cut.push(j);
            }
        }
      }
  }
  return Int32Array.from(out);
}

/** A point is usable when it names a cell on the grid and a positive area. */
export function validInflowPoint(p: InflowPoint, cells: number): boolean {
  return !!p && Number.isInteger(p.cell) && p.cell >= 0 && p.cell < cells && p.areaKm2 > 0 && Array.isArray(p.timeArea);
}

/** time-area histogram as shares summing to 1 (an empty or broken one = everything in the first hour) */
function shares(ta: number[] | undefined): number[] {
  const v = (ta ?? []).slice(0, MAX_BINS).map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const s = v.reduce((a, b) => a + b, 0);
  return s > 0 ? v.map((x) => x / s) : [1];
}

/** Excess runoff leaving the catchment's surface each hour, m³ (steps 1-2: losses, tanks). */
export function inflowExcess(p: InflowPoint, mm: ArrayLike<number>, params: Partial<SimParams> = {}): Float64Array {
  const prm = { ...DEFAULT_PARAMS, ...params };
  const n = mm.length;
  const areaM2 = Math.max(0, p.areaKm2 || 0) * 1e6;
  const perv = 1 - clamp01(p.impervious, 0.5);
  const served = clamp01(p.drainShare, 1);
  const drainMmH = Math.max(0, prm.drainCapacityMmHr) * (1 - clamp01(prm.drainBlockage)) * (DRAIN_LOCAL_SHARE + (1 - DRAIN_LOCAL_SHARE) * served);
  const infMmH = Math.max(0, prm.infiltrationMmHr);
  const tankShare = clamp01(p.tankShare);
  let room = Math.max(0, p.tankM3 || 0);
  const out = new Float64Array(n);
  let soil = 0; // mm per unit pervious area
  for (let t = 0; t < n; t++) {
    const r = Math.max(0, Number(mm[t]) || 0);
    const inf = Math.min(r, infMmH * (soil < SOIL_CAP_MM ? 1 : SOIL_SAT_FACTOR));
    soil = Math.max(0, soil + inf - SOIL_RECOVERY_MM_H);
    const excessMm = Math.max(0, r - perv * inf - drainMmH);
    const v = (excessMm / 1000) * areaM2;
    const held = Math.min(v * tankShare, room);
    room -= held;
    out[t] = v - held;
  }
  return out;
}

/** Hourly inflow volume (m³) of one point for an hourly rain series (mm): excess, then Clark routing. */
export function inflowHydrograph(p: InflowPoint, mm: ArrayLike<number>, params: Partial<SimParams> = {}): Float64Array {
  const pass = inflowExcess(p, mm, params);
  const n = pass.length;
  const ta = shares(p.timeArea);
  const trans = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    const v = pass[t];
    if (!v) continue;
    for (let k = 0; k < ta.length && t + k < n; k++) trans[t + k] += v * ta[k];
  }
  const K = Number(p.storageH);
  if (!(K > 0)) return trans;
  // linear reservoir dS/dt = I - S/K, exact for a constant inflow through each hour
  const out = new Float64Array(n);
  const e = Math.exp(-1 / K);
  let S = 0;
  for (let t = 0; t < n; t++) {
    const I = trans[t];
    const S1 = I * K + (S - I * K) * e;
    out[t] = I - (S1 - S);
    S = S1;
  }
  return out;
}

/** Point sources for SimCore.sources: hydraulic-grid cells and m³/s for one hour. */
export interface PointSources {
  cells: Int32Array;
  m3s: Float64Array;
}

/**
 * Inflow for one hydraulic grid: maps the points' fine-grid cells onto the (coarsened) grid the core
 * runs on, computes each point's hydrograph for a run, and hands the core its sources hour by hour.
 */
export class Inflow {
  readonly points: InflowPoint[];
  /** each point's cell on the hydraulic grid */
  readonly cells: Int32Array;
  private vols: Float64Array[] = [];
  private coarseWidth: number;
  private coarseHeight: number;
  private f: number;
  /** the cells each point's inflow is spread over, the point they belong to and their share of it */
  private srcCells: Int32Array;
  private srcOwner: Int32Array;
  private srcShare: Float64Array;

  /**
   * `fineWidth`/`fineCells`: the pack grid; `f`, `coarseWidth`, `coarseHeight`, `dx`: the hydraulic grid
   * (src/sim/grid.ts coarsen). With the height and cell size known, each point's inflow is spread over the
   * interior cells within SPREAD_M of its cell: a whole valley's flow through one small cell would have to
   * mound up metres high to pass the explicit scheme's face limiter.
   */
  constructor(points: InflowPoint[], fineWidth: number, fineCells: number, f: number, coarseWidth: number, coarseHeight?: number, dx?: number) {
    this.coarseWidth = coarseWidth;
    this.coarseHeight = coarseHeight ?? 0;
    this.f = Math.max(1, f);
    this.points = points.filter((p) => validInflowPoint(p, fineCells));
    this.cells = Int32Array.from(this.points, (p) => {
      const r = Math.floor(p.cell / fineWidth), c = p.cell % fineWidth;
      return Math.floor(r / f) * coarseWidth + Math.floor(c / f);
    });
    const cells: number[] = [], owner: number[] = [], share: number[] = [];
    const W = coarseWidth, H = coarseHeight ?? 0;
    const R = H && dx ? Math.max(1, Math.round(SPREAD_M / dx)) : 0;
    this.cells.forEach((i, k) => {
      const r0 = Math.floor(i / W), c0 = i % W, mine: number[] = [];
      for (let dr = -R; dr <= R; dr++)
        for (let dc = -R; dc <= R; dc++) {
          const r = r0 + dr, c = c0 + dc;
          if (dr * dr + dc * dc > R * R + 0.5 || r < 1 || c < 1 || r > H - 2 || c > W - 2) continue;
          mine.push(r * W + c);
        }
      if (!mine.length) mine.push(i);
      for (const j of mine) { cells.push(j); owner.push(k); share.push(1 / mine.length); }
    });
    this.srcCells = Int32Array.from(cells);
    this.srcOwner = Int32Array.from(owner);
    this.srcShare = Float64Array.from(share);
  }

  get size(): number {
    return this.points.length;
  }

  /**
   * Hydraulic-grid edge cells to close to outflow (SimCore.closeEdges): the pack's inflow edge runs
   * (meta.inflowEdge, where the district routing has outside land draining in) on this grid. Where a
   * valley or a lake is cut off by the grid edge, the pack's DEM slopes outwards and a free outfall
   * there would drain the inflow straight back out.
   */
  edgeCells(runs: readonly InflowEdgeRun[] | undefined): Int32Array {
    const W = this.coarseWidth, H = this.coarseHeight, f = this.f;
    const out = new Set<number>();
    if (!H) return new Int32Array(0);
    for (const run of runs ?? []) {
      const [side, a, b] = run ?? [];
      if (!(side >= 0 && side <= 3) || !(a >= 0) || !(b >= a)) continue;
      const len = side < 2 ? W : H;
      for (let t = Math.floor(a / f); t <= Math.min(len - 1, Math.floor(b / f)); t++)
        out.add(side === 0 ? t : side === 1 ? (H - 1) * W + t : side === 2 ? t * W : t * W + W - 1);
    }
    return Int32Array.from(out);
  }

  /** compute every point's hourly volumes for this run */
  prepare(mm: ArrayLike<number>, params: Partial<SimParams>): void {
    this.vols = this.points.map((p) => inflowHydrograph(p, mm, params));
  }

  /** m³ entering in `hour` over all points */
  volumeAt(hour: number): number {
    let s = 0;
    for (const v of this.vols) s += v[hour] ?? 0;
    return s;
  }

  /** sources for `hour` (null when nothing flows in, so a dry, empty grid can still skip the hour) */
  sourcesAt(hour: number): PointSources | null {
    if (!this.vols.length || !(this.volumeAt(hour) > 0)) return null;
    const m3s = new Float64Array(this.srcCells.length);
    for (let k = 0; k < m3s.length; k++) m3s[k] = (Math.max(0, this.vols[this.srcOwner[k]][hour] ?? 0) / 3600) * this.srcShare[k];
    return { cells: this.srcCells, m3s };
  }
}
