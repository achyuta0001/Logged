/**
 * Runs a whole hourly rain series on the (coarsened) grid and produces one fine-grid depth frame
 * per hour (Uint16 millimetres). Shared by the Web Worker and the inline fallback (tests / node).
 */
import type { InflowEdgeRun, InflowPoint, SimParams } from '../types.ts';
import { SimCore, type CoreGrids, type HourStats } from './core.ts';
import type { EngineChoice, EngineKind } from './kernel.ts';
import { coarsen, downscaleMm, limitPits, type Coarse } from './grid.ts';
import { Inflow, closeAcrossWater } from './inflow.ts';

export interface RunnerInit {
  width: number;
  height: number;
  cellSizeM: number;
  elevation: Float32Array;
  impervious?: Float32Array;
  drainMask?: Uint8Array;
  lakeMask?: Uint8Array;
  boundaryMask?: Uint8Array;
  params: SimParams;
  /** coarsening factor (1 = native grid). Default: 2 when the grid has > 60k cells. */
  factor?: number;
  /** upstream inflow points on this (fine) grid: terrain.meta.inflow, see src/sim/inflow.ts */
  inflow?: InflowPoint[];
  /** edge stretches of this (fine) grid where outside land drains in: terrain.meta.inflowEdge */
  inflowEdge?: InflowEdgeRun[];
  /** engine of the surface step (default 'auto': WebAssembly when it loads, else JS; same results) */
  engine?: EngineChoice;
}

export interface HourResult {
  hour: number;
  total: number;
  /** fine-grid depth, mm */
  frame: Uint16Array;
  stats: HourStats;
}

/**
 * Deepest a closed street depression may be below its spill level, m (src/sim/grid.ts limitPits):
 * deeper holes in the bare-earth DEM are surface-model residue, not places water stands 5-7 m deep.
 */
export const PIT_MAX_M = 2;
/** inflow edges reopen once the hour's inflow falls below this share of the run's peak hourly inflow */
export const EDGE_OPEN_SHARE = 0.05;

export function defaultFactor(width: number, height: number): number {
  return width * height > 60000 ? 2 : 1;
}

export class Runner {
  private coarse: Coarse;
  private core: SimCore;
  private fineZ: Float32Array;
  private fineInside?: Uint8Array;

  constructor(init: RunnerInit) {
    // closed street depressions capped at PIT_MAX_M; tanks and mapped drains are outlets, kept as they are
    const elevation = Float32Array.from(init.elevation);
    let outlets: Uint8Array | undefined;
    if (init.lakeMask || init.drainMask) {
      outlets = new Uint8Array(elevation.length);
      for (let i = 0; i < outlets.length; i++) outlets[i] = (init.lakeMask?.[i] || init.drainMask?.[i]) ? 1 : 0;
    }
    limitPits(elevation, init.width, init.height, PIT_MAX_M, outlets);
    const g: CoreGrids = {
      width: init.width,
      height: init.height,
      cellSizeM: init.cellSizeM,
      elevation,
      impervious: init.impervious,
      drainMask: init.drainMask,
      lakeMask: init.lakeMask,
      boundaryMask: init.boundaryMask,
    };
    this.coarse = coarsen(g, init.factor ?? defaultFactor(init.width, init.height));
    this.core = new SimCore(this.coarse.grids, init.params, { engine: init.engine });
    this.fineZ = elevation;
    this.fineInside = init.boundaryMask;
    if (init.inflow?.length) {
      const cg = this.coarse.grids;
      this.inflow = new Inflow(init.inflow, init.width, init.width * init.height, this.coarse.f, cg.width, cg.height, cg.cellSizeM);
      // where outside land drains in, the grid edge is an inflow boundary, not an outfall; so is the cut of
      // a tank such a stretch runs into (src/sim/inflow.ts closeAcrossWater)
      this.core.closeEdges(closeAcrossWater(this.inflow.edgeCells(init.inflowEdge), cg.width, cg.height, cg.cellSizeM, cg.elevation, cg.lakeMask));
      // drains below an inflow point were built for its whole catchment (src/sim/network.ts)
      this.core.net?.addUpstream(this.inflow.cells, this.inflow.points.map((p) => p.areaKm2 * 1e6), this.inflow.points.map((p) => p.timeArea.length * 3600));
    }
  }

  private inflow?: Inflow;

  get factor(): number {
    return this.coarse.f;
  }

  /** engine running the surface step */
  get engine(): EngineKind {
    return this.core.engine;
  }

  /** Synchronous run; `onHour` receives a fresh frame each hour (caller may transfer it). */
  run(mm: number[], params: SimParams, onHour: (r: HourResult) => void): void {
    this.core.setParams(params);
    this.core.reset();
    const total = mm.length;
    const fineArea = (this.coarse.grids.cellSizeM / this.coarse.f) ** 2;
    const inflow = this.inflow;
    inflow?.prepare(mm, params);
    // inflow edges are closed only while the inflow runs high: afterwards water pooled against them
    // (cut-off valleys and corners) drains out like at any other edge
    let peakIn = 0;
    if (inflow) for (let hour = 0; hour < total; hour++) peakIn = Math.max(peakIn, inflow.volumeAt(hour));
    for (let hour = 0; hour < total; hour++) {
      const v = Number(mm[hour]);
      this.core.sources = inflow?.sourcesAt(hour) ?? null;
      if (inflow) this.core.setEdgesClosed(peakIn > 0 && inflow.volumeAt(hour) >= EDGE_OPEN_SHARE * peakIn);
      const stats = this.core.stepHour(Number.isFinite(v) ? v : 0);
      const frame = new Uint16Array(this.fineZ.length);
      downscaleMm(this.coarse, this.core.h, this.fineZ, frame);
      // flooded area (> 0.1 m inside boundary) on the fine grid
      let fl = 0;
      const ins = this.fineInside;
      for (let i = 0; i < frame.length; i++) if (frame[i] > 100 && (!ins || ins[i])) fl++;
      stats.floodedAreaM2 = fl * fineArea;
      onHour({ hour, total, frame, stats });
    }
  }
}
