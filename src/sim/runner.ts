/**
 * Runs a whole hourly rain series on the (coarsened) grid and produces one fine-grid depth frame
 * per hour (Uint16 millimetres). Shared by the Web Worker and the inline fallback (tests / node).
 */
import type { SimParams } from '../types.ts';
import { SimCore, type CoreGrids, type HourStats } from './core.ts';
import { coarsen, downscaleMm, type Coarse } from './grid.ts';

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
}

export interface HourResult {
  hour: number;
  total: number;
  /** fine-grid depth, mm */
  frame: Uint16Array;
  stats: HourStats;
}

export function defaultFactor(width: number, height: number): number {
  return width * height > 60000 ? 2 : 1;
}

export class Runner {
  private coarse: Coarse;
  private core: SimCore;
  private fineZ: Float32Array;
  private fineInside?: Uint8Array;

  constructor(init: RunnerInit) {
    const g: CoreGrids = {
      width: init.width,
      height: init.height,
      cellSizeM: init.cellSizeM,
      elevation: init.elevation,
      impervious: init.impervious,
      drainMask: init.drainMask,
      lakeMask: init.lakeMask,
      boundaryMask: init.boundaryMask,
    };
    this.coarse = coarsen(g, init.factor ?? defaultFactor(init.width, init.height));
    this.core = new SimCore(this.coarse.grids, init.params);
    this.fineZ = init.elevation;
    this.fineInside = init.boundaryMask;
  }

  get factor(): number {
    return this.coarse.f;
  }

  /** Synchronous run; `onHour` receives a fresh frame each hour (caller may transfer it). */
  run(mm: number[], params: SimParams, onHour: (r: HourResult) => void): void {
    this.core.setParams(params);
    this.core.reset();
    const total = mm.length;
    const fineArea = (this.coarse.grids.cellSizeM / this.coarse.f) ** 2;
    for (let hour = 0; hour < total; hour++) {
      const v = Number(mm[hour]);
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
