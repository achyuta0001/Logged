/**
 * FloodEngine — main-thread facade over the simulation Web Worker (see CONTRACT.md).
 * Hourly depth frames are kept as Uint16 millimetres (~270 KB/hour on the 560098 grid) and
 * expanded to Float32 metres on snapshot().
 */
import type { RainSeries, SimParams, SimSnapshot, Terrain } from '../types.ts';
import { DEFAULT_PARAMS, type HourStats } from './core.ts';
import { Runner, type RunnerInit } from './runner.ts';
import type { WorkerIn, WorkerOut } from './worker.ts';
import { isEngineChoice, type EngineChoice, type EngineKind } from './kernel.ts';

export { DEFAULT_PARAMS } from './core.ts';
export type { HourStats } from './core.ts';
export type { EngineChoice, EngineKind } from './kernel.ts';

export interface EngineOptions {
  /** coarsening factor for the hydraulic grid (1 = native 15 m, 2 = 30 m). Default auto (2 for big grids). */
  factor?: number;
  /** force running on the main thread (tests / environments without Worker) */
  inline?: boolean;
  /**
   * engine of the surface step: 'auto' (default) runs WebAssembly when it loads, else JS; results are
   * bit-identical. Without this option the page's `?engine=js` (or `wasm`) query parameter decides.
   */
  engine?: EngineChoice;
}

/** `?engine=js|wasm|auto` on the page, if any */
function engineFromUrl(): EngineChoice | undefined {
  try {
    const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('engine');
    return isEngineChoice(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export class FloodEngine {
  private terrain: Terrain;
  private init: RunnerInit;
  private worker?: Worker;
  private inlineRunner?: Runner;
  private _params: SimParams;
  private frames: Uint16Array[] = [];
  private _stats: HourStats[] = [];
  private cacheKey = '';
  private runId = 0;
  private busy = false;
  private abortPending?: () => void;
  private snapCache = new Map<number, SimSnapshot>();
  private maxCache?: { hour: number; arr: Float32Array };
  /** ms of the last completed run */
  lastRunMs = 0;
  private _engine: EngineKind = 'js';

  private constructor(terrain: Terrain, params: SimParams, opts: EngineOptions) {
    this.terrain = terrain;
    this._params = params;
    const g = terrain.grids;
    const m = terrain.meta;
    // copies: the worker gets its own buffers, the main-thread Terrain stays intact
    this.init = {
      width: m.width,
      height: m.height,
      cellSizeM: m.cellSizeM,
      elevation: new Float32Array(g.elevation as Float32Array),
      impervious: g.impervious ? new Float32Array(g.impervious as Float32Array) : undefined,
      drainMask: g.drainMask ? new Uint8Array(g.drainMask as Uint8Array) : undefined,
      lakeMask: g.lakeMask ? new Uint8Array(g.lakeMask as Uint8Array) : undefined,
      boundaryMask: g.boundaryMask ? new Uint8Array(g.boundaryMask as Uint8Array) : undefined,
      params,
      factor: opts.factor,
      // M4: runoff from land outside the grid enters at these points (src/sim/inflow.ts)
      inflow: m.inflow?.length ? m.inflow.map((p) => ({ ...p, timeArea: [...p.timeArea] })) : undefined,
      inflowEdge: m.inflowEdge?.map((r) => [...r] as typeof r),
      engine: opts.engine ?? engineFromUrl(),
    };
    if (opts.inline || typeof Worker === 'undefined') {
      this.inlineRunner = new Runner(this.init);
      this._engine = this.inlineRunner.engine;
    }
  }

  static async create(terrain: Terrain, params?: Partial<SimParams>, opts: EngineOptions = {}): Promise<FloodEngine> {
    const e = new FloodEngine(terrain, { ...DEFAULT_PARAMS, ...params }, opts);
    if (!e.inlineRunner) await e.spawn();
    return e;
  }

  private spawn(): Promise<void> {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker = w;
    return new Promise((resolve, reject) => {
      const onMsg = (ev: MessageEvent<WorkerOut>) => {
        if (ev.data.type === 'ready') { this._engine = ev.data.engine; w.removeEventListener('message', onMsg); resolve(); }
        else if (ev.data.type === 'error') { w.removeEventListener('message', onMsg); reject(new Error(ev.data.message)); }
      };
      w.addEventListener('message', onMsg);
      w.addEventListener('error', (ev) => reject(new Error(ev.message || 'worker failed')), { once: true });
      w.postMessage({ type: 'init', init: this.init } satisfies WorkerIn);
    });
  }

  get params(): SimParams {
    return { ...this._params };
  }

  /** engine running the surface step: 'wasm' (src/sim/kernel.ts) or the JS fallback */
  get engine(): EngineKind {
    return this._engine;
  }

  setParams(p: Partial<SimParams>): void {
    this._params = { ...this._params, ...p };
  }

  /** number of hourly snapshots available */
  get hours(): number {
    return this.frames.length;
  }

  /** per-hour water budget (m3) and stats of the last run */
  get hourStats(): readonly HourStats[] {
    return this._stats;
  }

  /** Run the whole series (one snapshot per hour). Re-running identical input+params is a no-op. */
  async run(series: RainSeries, onProgress?: (hour: number, total: number) => void): Promise<void> {
    const mm = series.mm.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
    const key = JSON.stringify([mm, this._params]);
    if (key === this.cacheKey && this.frames.length === mm.length) {
      onProgress?.(mm.length, mm.length);
      return;
    }
    const id = ++this.runId;
    // a run is already in progress in the worker: it cannot be interrupted cooperatively, so restart it
    if (this.busy && this.worker) {
      this.worker.terminate();
      this.abortPending?.();
      await this.spawn();
      if (id !== this.runId) return;
    }
    this.cacheKey = '';
    this.frames = [];
    this._stats = [];
    this.snapCache.clear();
    this.maxCache = undefined;
    this.busy = true;
    const t0 = performance.now();
    try {
      if (this.inlineRunner) {
        const runner = this.inlineRunner;
        runner.run(mm, this._params, (r) => {
          this.frames.push(r.frame);
          this._stats.push(r.stats);
          onProgress?.(r.hour + 1, r.total);
        });
      } else {
        const w = this.worker!;
        await new Promise<void>((resolve, reject) => {
          this.abortPending = resolve; // superseded runs resolve quietly
          const onMsg = (ev: MessageEvent<WorkerOut>) => {
            const d = ev.data;
            if ('id' in d && d.id !== id) return;
            if (id !== this.runId) { w.removeEventListener('message', onMsg); resolve(); return; }
            if (d.type === 'hour') {
              this.frames[d.hour] = d.frame;
              this._stats[d.hour] = d.stats;
              onProgress?.(d.hour + 1, d.total);
            } else if (d.type === 'done') {
              w.removeEventListener('message', onMsg);
              resolve();
            } else if (d.type === 'error') {
              w.removeEventListener('message', onMsg);
              reject(new Error(d.message));
            }
          };
          w.addEventListener('message', onMsg);
          w.postMessage({ type: 'run', id, mm, params: this._params } satisfies WorkerIn);
        });
      }
    } finally {
      if (id === this.runId) this.busy = false;
    }
    if (id !== this.runId) return;
    this.cacheKey = key;
    this.lastRunMs = performance.now() - t0;
  }

  snapshot(hourIndex: number): SimSnapshot | undefined {
    const i = Math.floor(hourIndex);
    const f = this.frames[i];
    if (!f) return undefined;
    const hit = this.snapCache.get(i);
    if (hit) return hit;
    const depth = new Float32Array(f.length);
    for (let k = 0; k < f.length; k++) depth[k] = f[k] * 0.001;
    const st = this._stats[i];
    const snap: SimSnapshot = {
      hourIndex: i,
      depth,
      maxDepth: this.runningMax(i),
      totalVolumeM3: st?.volumeM3 ?? 0,
      floodedAreaM2: st?.floodedAreaM2 ?? 0,
    };
    this.snapCache.set(i, snap);
    if (this.snapCache.size > 6) this.snapCache.delete(this.snapCache.keys().next().value!);
    return snap;
  }

  /** running max depth (m) over hours 0..i (hourly samples) */
  private runningMax(i: number): Float32Array {
    let start = 0;
    let acc: Uint16Array;
    if (this.maxCache && this.maxCache.hour <= i) {
      start = this.maxCache.hour + 1;
      acc = this.maxAcc!;
    } else {
      acc = new Uint16Array(this.frames[0].length);
    }
    for (let h = start; h <= i; h++) {
      const f = this.frames[h];
      if (!f) break;
      for (let k = 0; k < f.length; k++) if (f[k] > acc[k]) acc[k] = f[k];
    }
    this.maxAcc = acc;
    const arr = new Float32Array(acc.length);
    for (let k = 0; k < acc.length; k++) arr[k] = acc[k] * 0.001;
    this.maxCache = { hour: i, arr };
    return arr;
  }
  private maxAcc?: Uint16Array;

  /** hour index with the largest flooded area in the last run (-1 if none) */
  peakHour(): number {
    let best = -1, v = 0;
    this._stats.forEach((s, i) => { if (s.floodedAreaM2 > v) { v = s.floodedAreaM2; best = i; } });
    return best;
  }

  get terrainRef(): Terrain {
    return this.terrain;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
  }
}
