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
import type { InflowPoint, SimParams } from '../types.ts';
import { DEFAULT_PARAMS } from './core.ts';

// the grid's vertical losses (src/sim/core.ts), per unit pervious area
const SOIL_CAP_MM = 100;
const SOIL_SAT_FACTOR = 0.15;
const SOIL_RECOVERY_MM_H = 2;
/** share of drain capacity acting everywhere (unmapped roadside drains), as DRAIN_LOCAL_SHARE in core.ts */
const DRAIN_LOCAL_SHARE = 0.3;
const MAX_BINS = 48;

const clamp01 = (v: number | undefined, d = 0) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v as number)) : d);

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
  readonly cells: Int32Array;
  private vols: Float64Array[] = [];
  private coarseWidth: number;

  /** `fineWidth`/`fineCells`: the pack grid; `f`, `coarseWidth`: the hydraulic grid (src/sim/grid.ts coarsen) */
  constructor(points: InflowPoint[], fineWidth: number, fineCells: number, f: number, coarseWidth: number) {
    this.coarseWidth = coarseWidth;
    this.points = points.filter((p) => validInflowPoint(p, fineCells));
    this.cells = Int32Array.from(this.points, (p) => {
      const r = Math.floor(p.cell / fineWidth), c = p.cell % fineWidth;
      return Math.floor(r / f) * coarseWidth + Math.floor(c / f);
    });
  }

  get size(): number {
    return this.points.length;
  }

  /**
   * Hydraulic-grid edge cells to close to outflow (SimCore.closeEdges): the stretch of edge each valley
   * enters through, half-width 120 m x sqrt(area in km²) clamped to 150..1200 m (valley floors widen
   * downstream), on every edge within that reach of the point's cell (so corners are covered). The land
   * beyond is upstream, so a free outfall there would just drain the inflow straight back out.
   */
  edgeCells(coarseHeight: number, dx: number): Int32Array {
    const W = this.coarseWidth, H = coarseHeight;
    const out = new Set<number>();
    this.points.forEach((p, k) => {
      const i = this.cells[k], r = Math.floor(i / W), c = i % W;
      const half = Math.max(1, Math.round(Math.min(1200, Math.max(150, 120 * Math.sqrt(p.areaKm2))) / dx));
      const d = [r, H - 1 - r, c, W - 1 - c];
      const near = Math.min(...d);
      d.forEach((de, side) => {
        if (de > Math.max(near, half)) return;
        for (let o = -half; o <= half; o++) {
          if (side < 2) {
            const cc = c + o;
            if (cc >= 0 && cc < W) out.add((side === 0 ? 0 : H - 1) * W + cc);
          } else {
            const rr = r + o;
            if (rr >= 0 && rr < H) out.add(rr * W + (side === 2 ? 0 : W - 1));
          }
        }
      });
    });
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
    return { cells: this.cells, m3s: Float64Array.from(this.vols, (v) => Math.max(0, v[hour] ?? 0) / 3600) };
  }
}
