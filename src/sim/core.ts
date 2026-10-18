/**
 * Pure (DOM-free) 2D surface-water model used by the Web Worker and by tests.
 *
 * Scheme: explicit finite-volume diffusive-wave on a 4-neighbour grid.
 *  - Face discharge from Manning: Q = hf^(5/3)/n * sqrt(|dη|/dx) * dx, where η = z + h and
 *    hf = max(η_i, η_j) - max(z_i, z_j) is the flow depth at the face (handles wet/dry fronts
 *    and lets water spill over the rim of a depression only once it is full).
 *  - Stability limiter: the volume moved across a face per step is capped at K * |dη| * A
 *    (K = 0.2 < 1/4, the explicit 2D diffusion limit) so water surfaces never overshoot/oscillate,
 *    which allows large adaptive time steps (seconds to minutes).
 *  - Positivity: per-cell outgoing volume is scaled to the water available (mass exactly conserved).
 *  - Sources/sinks: rain, Horton-like infiltration on the pervious fraction (with soil storage; once
 *    the soil is saturated, ponded water still seeps under its own head, Green-Ampt style),
 *    storm drains (30% of capacity acts everywhere as roadside drains, 70% at inlets within 2 cells
 *    of drainMask sized by the area each serves, radius 500 m), post-storm drainage of ponds (below),
 *    lake/tank storage (freeboard grows with tank area: small tanks fill and spill first),
 *    free outflow through grid edges.
 *  - Post-storm drainage: every cell belongs to the basin of the local low point its steepest-descent
 *    path ends in. Roadside drains run along paved ground and converge on that low point, so once the
 *    rain falls below their capacity, the capacity of the basin's dry paved area is free to empty the
 *    basin's pond (removed in proportion to depth, booked as `drained`). While it rains hard, the same
 *    drains are busy with direct runoff and the term is off.
 * All storage in Float64 so the volume budget closes to round-off.
 */
import type { SimParams } from '../types.ts';
import { DrainNetwork, type NetworkTotals } from './network.ts';

export interface CoreGrids {
  width: number;
  height: number;
  cellSizeM: number;
  elevation: Float32Array;
  impervious?: Float32Array;
  drainMask?: Uint8Array;
  lakeMask?: Uint8Array;
  boundaryMask?: Uint8Array;
}

export const DEFAULT_PARAMS: SimParams = { drainCapacityMmHr: 50, infiltrationMmHr: 10, drainBlockage: 0.4 };

export interface HourStats {
  /** m3 of surface water at end of hour */
  volumeM3: number;
  /** cells with depth > 0.1 m inside boundary, m2 */
  floodedAreaM2: number;
  maxDepthM: number;
  rainM3: number;
  infiltratedM3: number;
  /** net m3 taken off the surface by the drains (captured minus what the drain network gave back) */
  drainedM3: number;
  /** m3 in the drain network at the end of the hour (src/sim/network.ts; 0 without mapped drains) */
  networkM3: number;
  /** m3 the drain network pushed back onto the street at bottlenecks and dead ends during the hour */
  surchargeM3: number;
  /** m3 the drain network discharged across the grid edge or into tank storage during the hour */
  networkOutM3: number;
  lakeM3: number;
  outflowM3: number;
  /** m3 injected by point sources (upstream inflow, src/sim/inflow.ts) */
  inflowM3: number;
  steps: number;
}

export interface Budget {
  rain: number;
  infiltrated: number;
  drained: number;
  lake: number;
  outflow: number;
  inflow: number;
}

/** time-step tuning (seconds); exported for experiments */
export const DT_TUNING = { minRain: 4, minDry: 10, quiet: 30, recessionHours: 3 };
const K_LIMIT = 0.2; // fraction of |dη|*A allowed across a face per step
const H_MIN_FLOW = 1e-4; // m; thinner films don't route
const SOIL_CAP_M = 0.1; // soil storage on fully pervious ground before infiltration slows
const SOIL_SAT_FACTOR = 0.15; // infiltration rate fraction once soil storage is full
const SOIL_RECOVERY_M_S = 2 / 1000 / 3600; // soil storage drains at ~2 mm/h
const PONDED_HEAD_M = 0.3; // Green-Ampt: saturated seepage grows by (1 + h / this) under ponded water
/**
 * Flood cushion of a tank before it spills, m: Bengaluru tanks are kept near full by sewage inflow, so
 * only the band below the waste weir is free; bigger tanks have bigger bunds/weirs. 0.3 m at 1 ha,
 * +0.1 m per tenfold area, clamped 0.15..0.6 m (a flat 0.5 m let small tanks swallow any storm).
 */
export function lakeFreeboardM(areaM2: number): number {
  const d = 0.3 + 0.1 * Math.log10(Math.max(1, areaM2) / 1e4);
  return Math.min(0.6, Math.max(0.15, d));
}
const POND_MIN_M = 0.01; // water shallower than this is a film, not a pond (not drained by the basin term)
/** drains keep carrying upstream runoff after the rain eases: spare capacity builds up as 1 - exp(-t / this) */
const DRAIN_LAG_S = 1.5 * 3600;
const INLET_RADIUS = 2; // cells around a drainMask cell that act as inlets
const SERVE_RADIUS_M = 500;
const DRAIN_LOCAL_SHARE = 0.3; // share of drain capacity acting everywhere (unmapped roadside drains); calibrated so 35 mm/3 h gives only minor ponding
const LUT_STEP = 1e-4; // m
const LUT_N = 50001; // covers 0..5 m
const LUT23 = (() => {
  const t = new Float64Array(LUT_N);
  for (let i = 0; i < LUT_N; i++) t[i] = Math.pow(i * LUT_STEP, 2 / 3);
  return t;
})();

export class SimCore {
  readonly w: number;
  readonly hgt: number;
  readonly n: number;
  readonly dx: number;
  readonly area: number;
  /** water depth, m */
  readonly h: Float64Array;
  readonly z: Float64Array;
  /** cumulative budget, m3 */
  budget: Budget = { rain: 0, infiltrated: 0, drained: 0, lake: 0, outflow: 0, inflow: 0 };
  /** point sources for the current hour, m3/s per cell (upstream inflow: the runner sets them from src/sim/inflow.ts) */
  sources: { cells: Int32Array; m3s: Float64Array } | null = null;
  /** model time, s */
  time = 0;
  params: SimParams;

  private invN: Float64Array; // 1/n per cell
  /** mean 1/n of each cell's east and south face (0.5 x the sum: the same product as in the face formula) */
  private nEast: Float64Array;
  private nSouth: Float64Array;
  private pervious: Float64Array;
  private soil: Float64Array; // m infiltrated into soil storage (per unit pervious area)
  private inletRate: Float64Array; // m/s depth-equivalent removal capacity per cell (before blockage)
  private lakeComp: Int32Array; // lake component id, -1 if none
  private lakeRoom: Float64Array; // remaining storage per component, m3
  private lakeCells: Int32Array;
  private inside: Uint8Array;
  private edgeSlopeSqrt: Float64Array; // sqrt(slope) for edge cells, 0 otherwise
  private fx: Float64Array; // east-face volume of last step (+ = i -> i+1)
  private fy: Float64Array; // south-face volume (+ = i -> i+w)
  private out: Float64Array; // outgoing volume per cell
  private wetRowMin: Int32Array;
  private wetRowMax: Int32Array;
  /** 1 on drain-network cells: their channel flow is the network's, so it does not set the time step */
  private chan: Uint8Array;
  private lastVmax = 0.5;
  private hoursSinceRain = 1e9;
  /** s since rain last exceeded the roadside drains' capacity */
  private drainIdleS = 1e9;
  /** share of drain capacity acting as distributed roadside drains (1 when no drains are mapped) */
  private localShare = DRAIN_LOCAL_SHARE;
  private edgeOut: Float64Array;
  private lakeRoomInit: Float64Array;
  /** storm-drain network fed by the inlets (null when no drains are mapped: inlets are plain sinks) */
  readonly net: DrainNetwork | null = null;
  private net0: NetworkTotals | null = null; // network totals at the start of the hour
  /** sealed fraction per cell (0..1) */
  private imp: Float64Array;
  /** basin id per cell: the local low point its D8 steepest-descent path (unfilled z) ends in */
  readonly basin: Int32Array;
  /** sum of sealed fraction over each basin's cells (roadside-drain "frontage", in cells) */
  private basinImp: Float64Array;
  private basinWetImp: Float64Array; // per-step scratch
  private basinPond: Float64Array; // per-step scratch: sum of pond depth (m*cells)

  constructor(g: CoreGrids, params: Partial<SimParams> = {}) {
    this.params = { ...DEFAULT_PARAMS, ...params };
    const w = (this.w = g.width);
    const H = (this.hgt = g.height);
    const n = (this.n = w * H);
    this.dx = g.cellSizeM;
    this.area = g.cellSizeM * g.cellSizeM;
    this.h = new Float64Array(n);
    this.z = new Float64Array(n);
    // elevation; non-finite -> high wall
    let zmax = -Infinity;
    for (let i = 0; i < n; i++) if (Number.isFinite(g.elevation[i]) && g.elevation[i] > -1000) zmax = Math.max(zmax, g.elevation[i]);
    for (let i = 0; i < n; i++) {
      const e = g.elevation[i];
      this.z[i] = Number.isFinite(e) && e > -1000 ? e : zmax + 100;
    }
    this.invN = new Float64Array(n);
    this.pervious = new Float64Array(n);
    this.imp = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const imp = g.impervious ? Math.min(1, Math.max(0, g.impervious[i] || 0)) : 0.5;
      this.imp[i] = imp;
      this.pervious[i] = 1 - imp;
      // sealed surfaces ~0.015, vegetated/rough ~0.06
      this.invN[i] = 1 / (0.015 * imp + 0.06 * (1 - imp));
    }
    this.nEast = new Float64Array(n);
    this.nSouth = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if ((i % w) + 1 < w) this.nEast[i] = 0.5 * (this.invN[i] + this.invN[i + 1]);
      if (i + w < n) this.nSouth[i] = 0.5 * (this.invN[i] + this.invN[i + w]);
    }
    this.soil = new Float64Array(n);
    this.inside = g.boundaryMask ?? new Uint8Array(n).fill(1);
    this.fx = new Float64Array(n);
    this.fy = new Float64Array(n);
    this.out = new Float64Array(n);
    this.wetRowMin = new Int32Array(H);
    this.wetRowMax = new Int32Array(H);
    this.chan = new Uint8Array(n);

    // edge outflow slopes
    this.edgeSlopeSqrt = new Float64Array(n);
    const setEdge = (i: number, inner: number) => {
      const s = Math.max(0.001, (this.z[inner] - this.z[i]) / this.dx);
      this.edgeSlopeSqrt[i] = Math.max(this.edgeSlopeSqrt[i], Math.sqrt(s));
    };
    if (H > 1 && w > 1) {
      for (let c = 0; c < w; c++) {
        setEdge(c, c + w);
        setEdge((H - 1) * w + c, (H - 2) * w + c);
      }
      for (let r = 0; r < H; r++) {
        setEdge(r * w, r * w + 1);
        setEdge(r * w + w - 1, r * w + w - 2);
      }
    }

    // ---- storm-drain inlets ----
    this.inletRate = new Float64Array(n);
    const drain = g.drainMask;
    let anyDrain = false;
    if (drain) for (let i = 0; i < n; i++) if (drain[i]) { anyDrain = true; break; }
    if (anyDrain && drain) {
      const isInlet = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (!drain[i]) continue;
        const r0 = Math.floor(i / w), c0 = i % w;
        for (let dr = -INLET_RADIUS; dr <= INLET_RADIUS; dr++)
          for (let dc = -INLET_RADIUS; dc <= INLET_RADIUS; dc++) {
            const r = r0 + dr, c = c0 + dc;
            if (r < 0 || c < 0 || r >= H || c >= w) continue;
            isInlet[r * w + c] = 1;
          }
      }
      // multi-source BFS: assign every cell within SERVE_RADIUS to its nearest inlet
      const owner = new Int32Array(n).fill(-1);
      const dist = new Int32Array(n).fill(-1);
      const q = new Int32Array(n);
      let qh = 0, qt = 0;
      for (let i = 0; i < n; i++) if (isInlet[i]) { owner[i] = i; dist[i] = 0; q[qt++] = i; }
      const maxSteps = Math.ceil(SERVE_RADIUS_M / this.dx);
      while (qh < qt) {
        const i = q[qh++];
        if (dist[i] >= maxSteps) continue;
        const r = Math.floor(i / w), c = i % w;
        const nb = [c + 1 < w ? i + 1 : -1, c > 0 ? i - 1 : -1, r + 1 < H ? i + w : -1, r > 0 ? i - w : -1];
        for (const j of nb) {
          if (j < 0 || owner[j] >= 0) continue;
          owner[j] = owner[i];
          dist[j] = dist[i] + 1;
          q[qt++] = j;
        }
      }
      const served = new Float64Array(n);
      for (let i = 0; i < n; i++) if (owner[i] >= 0) served[owner[i]] += 1;
      // Capacity split: a share acts locally everywhere (unmapped roadside drains / inlets), the rest
      // is concentrated at mapped drains, sized by the area each inlet serves.
      for (let i = 0; i < n; i++) this.inletRate[i] = DRAIN_LOCAL_SHARE + (1 - DRAIN_LOCAL_SHARE) * served[i];
    } else {
      // no mapped drains: the whole capacity acts as distributed roadside drains
      this.inletRate.fill(1);
      this.localShare = 1;
    }

    // ---- lakes ----
    this.lakeComp = new Int32Array(n).fill(-1);
    const lakeCellsArr: number[] = [];
    const rooms: number[] = [];
    if (g.lakeMask) {
      const lm = g.lakeMask;
      const stack: number[] = [];
      for (let s = 0; s < n; s++) {
        if (!lm[s] || this.lakeComp[s] >= 0) continue;
        const id = rooms.length;
        let count = 0;
        stack.push(s);
        this.lakeComp[s] = id;
        while (stack.length) {
          const i = stack.pop()!;
          count++;
          lakeCellsArr.push(i);
          const r = Math.floor(i / w), c = i % w;
          const nb = [c + 1 < w ? i + 1 : -1, c > 0 ? i - 1 : -1, r + 1 < H ? i + w : -1, r > 0 ? i - w : -1];
          for (const j of nb) if (j >= 0 && lm[j] && this.lakeComp[j] < 0) { this.lakeComp[j] = id; stack.push(j); }
        }
        const a = count * this.area;
        rooms.push(a * lakeFreeboardM(a));
      }
    }
    this.lakeCells = Int32Array.from(lakeCellsArr);
    this.lakeRoom = Float64Array.from(rooms);
    this.lakeRoomInit = Float64Array.from(rooms);
    this.edgeOut = new Float64Array(4 * (w + H) + 8);

    // ---- drain network: captured water is routed downstream and can surcharge (src/sim/network.ts) ----
    if (anyDrain && drain) {
      const net = new DrainNetwork({
        w, h: H, dx: this.dx, z: this.z, drainMask: drain, lakeComp: this.lakeComp, lakeRoom: this.lakeRoom,
        serveRadiusCells: Math.ceil(SERVE_RADIUS_M / this.dx),
      });
      if (net.size) {
        this.net = net;
        for (let k = 0; k < net.size; k++) this.chan[net.cell[k]] = 1;
      }
    }

    // ---- basins (for post-storm drainage) ----
    const z = this.z;
    const down = new Int32Array(n).fill(-1);
    const d2 = Math.SQRT2;
    for (let r = 0; r < H; r++)
      for (let c = 0; c < w; c++) {
        const i = r * w + c;
        let best = 0, bj = -1;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= H || cc >= w) continue;
            const j = rr * w + cc;
            const s = (z[i] - z[j]) / (dr && dc ? d2 : 1);
            if (s > best) { best = s; bj = j; }
          }
        down[i] = bj;
      }
    const basin = (this.basin = new Int32Array(n).fill(-1));
    const path: number[] = [];
    let nb = 0;
    for (let s = 0; s < n; s++) {
      if (basin[s] >= 0) continue;
      let i = s;
      path.length = 0;
      while (basin[i] < 0 && down[i] >= 0) { path.push(i); i = down[i]; } // strictly descending: no cycles
      if (basin[i] < 0) basin[i] = nb++;
      const b = basin[i];
      for (const p of path) basin[p] = b;
    }
    this.basinImp = new Float64Array(nb);
    for (let i = 0; i < n; i++) if (this.lakeComp[i] < 0) this.basinImp[basin[i]] += this.imp[i];
    this.basinWetImp = new Float64Array(nb);
    this.basinPond = new Float64Array(nb);
  }

  /** per-lake storage capacity and what is still free, m3 (diagnostics) */
  lakeStatus(): { cells: number; capacityM3: number; freeM3: number }[] {
    const cells = new Array<number>(this.lakeRoom.length).fill(0);
    for (const i of this.lakeCells) cells[this.lakeComp[i]]++;
    return Array.from(this.lakeRoomInit, (cap, k) => ({ cells: cells[k], capacityM3: cap, freeM3: this.lakeRoom[k] }));
  }

  /**
   * Close grid-edge cells to outflow: inflow boundaries, where the land beyond the edge is upstream
   * (src/sim/inflow.ts). They stay registered: `setEdgesClosed(false)` reopens them as free outfalls
   * (the runner does once the inflow has receded, so water pooled against them can leave).
   */
  closeEdges(cells: ArrayLike<number>): void {
    const keep = new Map<number, number>();
    for (let k = 0; k < this.closedCells.length; k++) keep.set(this.closedCells[k], this.closedOpenSlope[k]);
    this.setEdgesClosed(false);
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k];
      if (i >= 0 && i < this.n && !keep.has(i)) keep.set(i, this.edgeSlopeSqrt[i]);
    }
    this.closedCells = Int32Array.from(keep.keys());
    this.closedOpenSlope = Float64Array.from(keep.values());
    this.setEdgesClosed(true);
  }

  /** Close (true) or reopen (false) the edge cells registered by closeEdges. */
  setEdgesClosed(on: boolean): void {
    const cells = this.closedCells, open = this.closedOpenSlope, es = this.edgeSlopeSqrt;
    for (let k = 0; k < cells.length; k++) es[cells[k]] = on ? 0 : open[k];
    this.edgesClosed = on && cells.length > 0;
  }

  /** whether the registered inflow edge cells are currently closed */
  edgesClosed = false;
  private closedCells = new Int32Array(0);
  private closedOpenSlope = new Float64Array(0);

  reset(): void {
    this.h.fill(0);
    this.soil.fill(0);
    this.lakeRoom.set(this.lakeRoomInit);
    this.budget = { rain: 0, infiltrated: 0, drained: 0, lake: 0, outflow: 0, inflow: 0 };
    this.time = 0;
    this.lastVmax = 0.5;
    this.hoursSinceRain = 1e9;
    this.drainIdleS = 1e9;
    this.net?.reset();
  }

  setParams(p: Partial<SimParams>): void {
    this.params = { ...this.params, ...p };
  }

  totalVolume(): number {
    let s = 0;
    const h = this.h;
    for (let i = 0; i < this.n; i++) s += h[i];
    return s * this.area;
  }

  /** Advance one hour with `rainMm` falling uniformly during it. */
  stepHour(rainMm: number, maxDepth?: Float32Array): HourStats {
    const b0 = { ...this.budget };
    this.net0 = this.net ? { ...this.net.totals } : null;
    let t = 0;
    let steps = 0;
    const rainRate = Math.max(0, rainMm) / 1000 / 3600; // m/s
    const dry = rainRate === 0;
    // quiescent shortcut: no rain, no inflow and essentially no surface water
    if (dry && !this.sources && this.totalVolume() < 1e-3 && !this.net?.active()) {
      this.recoverSoil(3600);
      this.drainIdleS += 3600;
      this.time += 3600;
      return this.stats(b0, 0);
    }
    if (dry) this.hoursSinceRain++;
    else this.hoursSinceRain = 0;
    // Time step. The face limiter keeps the scheme stable for any dt, so dt only trades how fast
    // water can travel (max ~1 cell per step) against cost. Short steps while it rains and in the
    // first hours of recession, long steps once the surface is just ponds slowly draining.
    let dtMin: number, dtMax: number;
    if (!dry) { dtMin = DT_TUNING.minRain; dtMax = 60; }
    else if (this.hoursSinceRain <= DT_TUNING.recessionHours) { dtMin = DT_TUNING.minDry; dtMax = 300; }
    else { dtMin = DT_TUNING.quiet; dtMax = 900; }
    while (t < 3600 - 1e-9) {
      const dtCfl = (0.7 * this.dx) / Math.max(this.lastVmax, 1e-3);
      let dt = Math.min(Math.max(dtCfl, dtMin), dtMax);
      if (t + dt > 3600) dt = 3600 - t;
      if (3600 - (t + dt) < 1) dt = 3600 - t;
      this.step(dt, rainRate);
      if (maxDepth) {
        const h = this.h;
        for (let i = 0; i < this.n; i++) if (h[i] > maxDepth[i]) maxDepth[i] = h[i];
      }
      t += dt;
      steps++;
    }
    this.time += 3600;
    return this.stats(b0, steps);
  }

  private stats(b0: Budget, steps: number): HourStats {
    const h = this.h;
    let vol = 0, fl = 0, mx = 0;
    for (let i = 0; i < this.n; i++) {
      const d = h[i];
      vol += d;
      if (d > 0.1 && this.inside[i]) fl++;
      if (d > mx) mx = d;
    }
    const b = this.budget;
    const nt = this.net?.totals, n0 = this.net0;
    return {
      volumeM3: vol * this.area,
      floodedAreaM2: fl * this.area,
      maxDepthM: mx,
      rainM3: b.rain - b0.rain,
      infiltratedM3: b.infiltrated - b0.infiltrated,
      drainedM3: b.drained - b0.drained,
      networkM3: this.net ? this.net.storage() : 0,
      surchargeM3: nt && n0 ? nt.surcharge - n0.surcharge : 0,
      networkOutM3: nt && n0 ? nt.out + nt.lake - n0.out - n0.lake : 0,
      lakeM3: b.lake - b0.lake,
      outflowM3: b.outflow - b0.outflow,
      inflowM3: b.inflow - b0.inflow,
      steps,
    };
  }

  private recoverSoil(dt: number): void {
    const s = this.soil;
    const d = SOIL_RECOVERY_M_S * dt;
    for (let i = 0; i < this.n; i++) if (s[i] > 0) s[i] = Math.max(0, s[i] - d);
  }

  /** wet extent per row (cells deeper than H_MIN_FLOW), by a pass over the grid */
  private wetExtents(): void {
    const { w, hgt: H, h } = this;
    const rowMin = this.wetRowMin, rowMax = this.wetRowMax;
    for (let r = 0; r < H; r++) {
      let lo = w, hi = -1;
      const base = r * w;
      for (let c = 0; c < w; c++) if (h[base + c] > H_MIN_FLOW) { if (lo === w) lo = c; hi = c; }
      rowMin[r] = lo;
      rowMax[r] = hi;
    }
  }

  /**
   * Remove ponded water through the basin's free roadside-drain capacity. `capDepth` = free capacity
   * per fully sealed cell this step (m). Returns the removed depth summed over cells (m*cells).
   */
  private drainPonds(capDepth: number): number {
    const { w, hgt: H, h, basin, imp, lakeComp } = this;
    const wetImp = this.basinWetImp, pond = this.basinPond, bImp = this.basinImp;
    // ponds are deeper than H_MIN_FLOW: only the wet extents hold any (same cells, same order)
    const rowMin = this.wetRowMin, rowMax = this.wetRowMax;
    wetImp.fill(0);
    pond.fill(0);
    let any = false;
    for (let r = 0; r < H; r++) {
      const hi = rowMax[r];
      for (let i = r * w + rowMin[r], e = r * w + hi; i <= e; i++) {
        const d = h[i];
        if (d <= POND_MIN_M) continue;
        const b = basin[i];
        wetImp[b] += imp[i]; // wet cells' own drains are already counted by the local inlet term
        if (lakeComp[i] < 0) { pond[b] += d; any = true; }
      }
    }
    if (!any) return 0;
    // per-basin fraction of the pond that can leave this step
    for (let b = 0; b < pond.length; b++) {
      if (pond[b] <= 0) continue;
      const room = capDepth * (bImp[b] - wetImp[b]);
      pond[b] = room <= 0 ? 0 : room >= pond[b] ? 1 : room / pond[b];
    }
    let removed = 0;
    for (let r = 0; r < H; r++) {
      const hi = rowMax[r];
      for (let i = r * w + rowMin[r], e = r * w + hi; i <= e; i++) {
        const d = h[i];
        if (d <= POND_MIN_M || lakeComp[i] >= 0) continue;
        const f = pond[basin[i]];
        if (f <= 0) continue;
        const x = d * f;
        h[i] = d - x;
        removed += x;
      }
    }
    return removed;
  }

  /** One explicit step of length dt seconds. */
  step(dt: number, rainRate: number): void {
    const { w, hgt: H, n, dx, area: A, h, z, invN } = this;
    const p = this.params;

    // point sources (upstream inflow) enter first, so soil, drains and lakes act on them like on rain
    const src = this.sources;
    if (src) {
      let v = 0;
      for (let k = 0; k < src.cells.length; k++) {
        const q = src.m3s[k] * dt;
        h[src.cells[k]] += q / A;
        v += q;
      }
      this.budget.inflow += v;
    }

    // ---- vertical sources / sinks ----
    const rainDepth = rainRate * dt;
    const infBase = (p.infiltrationMmHr / 1000 / 3600) * dt;
    const soil = this.soil, perv = this.pervious;
    const soilRec = SOIL_RECOVERY_M_S * dt;
    let infTot = 0;
    // storm-drain capacity this step, m. With mapped drains the inlets' capture is folded into this
    // pass (same per-cell order: rain, soil, inlets; src/sim/network.ts beginCapture)
    const cap = (Math.max(0, p.drainCapacityMmHr) * (1 - Math.min(1, Math.max(0, p.drainBlockage)))) / 1000 / 3600 * dt;
    const net = this.net;
    const fold = net !== null && cap > 0;
    if (fold) net.beginCapture();
    const cellNode = net ? net.cellNode : null, tankCell = net ? net.tankCell : null;
    const want = net ? net.want : null, rcell = net ? net.rcell : null, rate = this.inletRate;
    let capRemoved = 0, capSink = 0;
    for (let i = 0; i < n; i++) {
      let d = h[i] + rainDepth;
      const pv = perv[i];
      let s = soil[i];
      if (pv > 0 && infBase > 0) {
        // saturated soil still takes ponded water, faster under a deeper head (small pits leak away)
        const pot = infBase * (s < SOIL_CAP_M ? 1 : SOIL_SAT_FACTOR * (1 + d / PONDED_HEAD_M)) * pv;
        if (d > 0 && pot > 0) {
          const inf = d < pot ? d : pot;
          d -= inf;
          infTot += inf;
          s += inf / pv;
        }
      }
      s -= soilRec;
      soil[i] = s > 0 ? s : 0;
      if (fold) {
        if (d <= 0) rcell![i] = 0;
        else {
          const k = cellNode![i];
          // water standing on a tank above its cushion leaves through the weir: all of it is offered
          const m = tankCell![i] && k >= 0 ? d : cap * rate[i];
          const r = d < m ? d : m;
          rcell![i] = r;
          d -= r;
          capRemoved += r;
          if (k >= 0) want![k] += r * A;
          else capSink += r;
        }
      }
      h[i] = d;
    }
    this.budget.rain += rainDepth * n * A;
    this.budget.infiltrated += infTot * A;

    // storm-drain inlets. With mapped drains the captured water enters the drain network, which routes
    // it downstream and gives back what it cannot carry (src/sim/network.ts); without, inlets are sinks.
    if (cap > 0 || net) {
      let dr = 0;
      if (net) dr = net.exchange(h, cap, rate, cap / dt, dt, fold ? { removed: capRemoved, sink: capSink } : undefined);
      else {
        for (let i = 0; i < n; i++) {
          const d = h[i];
          if (d <= 0) continue;
          const m = cap * rate[i];
          const r = d < m ? d : m;
          h[i] = d - r;
          dr += r;
        }
      }
      // the wet extents (below) are taken here: pond drainage and the tanks only take water from now on,
      // so they stay a superset of what the routing needs, and the pond pass visits only them
      this.wetExtents();
      // post-storm drainage: once rain is below the roadside drains' capacity, the spare capacity of
      // each basin's dry paved area drains that basin's pond (deepest water first, mass-exact)
      const local = cap * this.localShare;
      if (cap <= 0) { /* no capacity: nothing to drain */ }
      else if (rainDepth >= local) this.drainIdleS = 0;
      else {
        this.drainIdleS += dt;
        const spare = (1 - rainDepth / local) * (1 - Math.exp(-this.drainIdleS / DRAIN_LAG_S));
        const pd = this.drainPonds(spare * local);
        dr += pd;
        if (net) net.totals.sink += pd * A; // pond drainage stays a sink (not routed through the network)
      }
      this.budget.drained += dr * A;
    }

    // lakes absorb into their storage until full
    if (this.lakeCells.length) {
      let lk = 0;
      const lc = this.lakeCells, comp = this.lakeComp, room = this.lakeRoom;
      for (let k = 0; k < lc.length; k++) {
        const i = lc[k];
        const d = h[i];
        if (d <= 0) continue;
        const c = comp[i];
        const rm = room[c];
        if (rm <= 0) continue;
        const v = Math.min(d * A, rm);
        room[c] = rm - v;
        h[i] = d - v / A;
        lk += v;
      }
      this.budget.lake += lk;
    }

    // ---- horizontal routing ----
    if (!(cap > 0 || net)) this.wetExtents();
    const rowMin = this.wetRowMin, rowMax = this.wetRowMax;
    const fx = this.fx, fy = this.fy, out = this.out, chan = this.chan, nE = this.nEast, nS = this.nSouth;
    out.fill(0);
    const kA = K_LIMIT * A;
    const invDx = 1 / dx;
    let vmax = 0;
    for (let r = 0; r < H; r++) {
      const base = r * w;
      // east faces: need either cell wet
      let lo = rowMin[r], hi = rowMax[r];
      if (hi >= 0) {
        lo = lo > 0 ? lo - 1 : 0;
        if (hi > w - 2) hi = w - 2;
        for (let c = lo; c <= hi; c++) {
          const i = base + c, j = i + 1;
          const ei = z[i] + h[i], ej = z[j] + h[j];
          const zf = z[i] > z[j] ? z[i] : z[j];
          const d = ei - ej;
          const hf = (d > 0 ? ei : ej) - zf;
          if (hf <= H_MIN_FLOW || d === 0) { fx[i] = 0; continue; }
          const ad = d > 0 ? d : -d;
          const h23 = hf < 5 ? LUT23[(hf / LUT_STEP) | 0] : Math.pow(hf, 2 / 3);
          const q = hf * h23 * nE[i] * Math.sqrt(ad * invDx) * dx; // m3/s
          if (hf > 0.02 && !chan[i] && !chan[j]) { const v = q / (hf * dx); if (v > vmax) vmax = v; }
          let vol = q * dt;
          const lim = kA * ad;
          if (vol > lim) vol = lim;
          if (d > 0) { fx[i] = vol; out[i] += vol; } else { fx[i] = -vol; out[j] += vol; }
        }
        // clear stale faces outside the computed range
        for (let c = 0; c < lo; c++) fx[base + c] = 0;
        for (let c = hi + 1; c < w; c++) fx[base + c] = 0;
      } else {
        for (let c = 0; c < w; c++) fx[base + c] = 0;
      }
      // south faces
      if (r < H - 1) {
        const lo2 = Math.min(rowMin[r], rowMin[r + 1]);
        const hi2 = Math.max(rowMax[r], rowMax[r + 1]);
        if (hi2 >= 0) {
          for (let c = 0; c < lo2; c++) fy[base + c] = 0;
          for (let c = hi2 + 1; c < w; c++) fy[base + c] = 0;
          for (let c = lo2; c <= hi2; c++) {
            const i = base + c, j = i + w;
            const ei = z[i] + h[i], ej = z[j] + h[j];
            const zf = z[i] > z[j] ? z[i] : z[j];
            const d = ei - ej;
            const hf = (d > 0 ? ei : ej) - zf;
            if (hf <= H_MIN_FLOW || d === 0) { fy[i] = 0; continue; }
            const ad = d > 0 ? d : -d;
            const h23 = hf < 5 ? LUT23[(hf / LUT_STEP) | 0] : Math.pow(hf, 2 / 3);
            const q = hf * h23 * nS[i] * Math.sqrt(ad * invDx) * dx;
            if (hf > 0.02 && !chan[i] && !chan[j]) { const v = q / (hf * dx); if (v > vmax) vmax = v; }
            let vol = q * dt;
            const lim = kA * ad;
            if (vol > lim) vol = lim;
            if (d > 0) { fy[i] = vol; out[i] += vol; } else { fy[i] = -vol; out[j] += vol; }
          }
        } else {
          for (let c = 0; c < w; c++) fy[base + c] = 0;
        }
      }
    }
    // edge outflow (free boundary)
    const es = this.edgeSlopeSqrt;
    const eo = this.edgeOut;
    let eCount = 0;
    const edgeVisit = (i: number) => {
      const d = h[i];
      if (d <= H_MIN_FLOW) return;
      const q = d * (d < 5 ? LUT23[(d / LUT_STEP) | 0] : Math.pow(d, 2 / 3)) * invN[i] * es[i] * dx;
      let vol = q * dt;
      const lim = kA * d;
      if (vol > lim) vol = lim;
      out[i] += vol;
      eo[eCount * 2] = i;
      eo[eCount * 2 + 1] = vol;
      eCount++;
    };
    if (rowMax[0] >= 0) for (let c = 0; c < w; c++) edgeVisit(c);
    if (H > 1 && rowMax[H - 1] >= 0) for (let c = 0; c < w; c++) edgeVisit((H - 1) * w + c);
    for (let r = 1; r < H - 1; r++) {
      if (rowMax[r] < 0) continue;
      edgeVisit(r * w);
      if (w > 1) edgeVisit(r * w + w - 1);
    }

    // positivity: scale factor per donor cell, stored in out[] (out -> scale). Donors hold more than
    // H_MIN_FLOW (a face's flow depth never exceeds its donor's depth), so only wet extents are visited.
    for (let r = 0; r < H; r++) {
      const hi = rowMax[r];
      if (hi < 0) continue;
      const base = r * w;
      for (let c = rowMin[r]; c <= hi; c++) {
        const i = base + c;
        const o = out[i];
        if (o > 0) {
          const avail = h[i] * A;
          out[i] = o > avail ? avail / o : 1;
        }
      }
    }
    // apply fluxes
    const invA = 1 / A;
    for (let r = 0; r < H; r++) {
      const base = r * w;
      const lo = Math.max(0, Math.min(rowMin[r], r > 0 ? rowMin[r - 1] : w, r < H - 1 ? rowMin[r + 1] : w) - 1);
      const hi = Math.min(w - 1, Math.max(rowMax[r], r > 0 ? rowMax[r - 1] : -1, r < H - 1 ? rowMax[r + 1] : -1) + 1);
      if (hi < 0) continue;
      for (let c = lo; c <= hi; c++) {
        const i = base + c;
        const a = fx[i];
        if (a !== 0 && c < w - 1) {
          const j = i + 1;
          const v = a > 0 ? a * out[i] : a * out[j];
          h[i] -= v * invA;
          h[j] += v * invA;
        }
        const b = fy[i];
        if (b !== 0 && r < H - 1) {
          const j = i + w;
          const v = b > 0 ? b * out[i] : b * out[j];
          h[i] -= v * invA;
          h[j] += v * invA;
        }
      }
    }
    let outflow = 0;
    for (let k = 0; k < eCount; k++) {
      const i = eo[k * 2];
      const v = eo[k * 2 + 1] * out[i];
      h[i] -= v * invA;
      outflow += v;
    }
    this.budget.outflow += outflow;
    // clamp round-off negatives (tracked into outflow to keep the budget exact); only cells the fluxes
    // touched can be negative: the same row ranges as above
    let neg = 0;
    for (let r = 0; r < H; r++) {
      const base = r * w;
      const lo = Math.max(0, Math.min(rowMin[r], r > 0 ? rowMin[r - 1] : w, r < H - 1 ? rowMin[r + 1] : w) - 1);
      const hi = Math.min(w - 1, Math.max(rowMax[r], r > 0 ? rowMax[r - 1] : -1, r < H - 1 ? rowMax[r + 1] : -1) + 1);
      for (let c = lo; c <= hi; c++) {
        const i = base + c;
        if (h[i] < 0) { neg += h[i]; h[i] = 0; }
      }
    }
    this.budget.outflow += neg * A; // tiny negative correction
    this.lastVmax = vmax;
  }
}
