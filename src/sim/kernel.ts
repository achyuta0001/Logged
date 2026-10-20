/**
 * The surface step in WebAssembly (src/sim/wasm/surface.as.ts): loading, memory layout, JS fallback.
 *
 * SimCore keeps its per-cell arrays in one WebAssembly memory per instance and works on typed-array
 * views of it, so the kernel and the JS around it (drain network, inflow, lakes, stats) share the same
 * numbers without copies. The memory is sized once and never grows (growing would detach the views).
 * The module is embedded (surface.bin.ts) and compiled synchronously on first use; when WebAssembly is
 * unavailable or the module fails to compile or instantiate, SimCore runs its JS step instead, which
 * gives bit-identical results (src/sim/__tests__/wasm.test.ts).
 */
import { SURFACE_WASM } from './wasm/surface.bin.ts';

/** which engine runs SimCore's step: 'auto' = WebAssembly when it loads, else JS; 'wasm' = fail without it */
export type EngineChoice = 'auto' | 'js' | 'wasm';
export type EngineKind = 'js' | 'wasm';

export function isEngineChoice(v: unknown): v is EngineChoice {
  return v === 'auto' || v === 'js' || v === 'wasm';
}

/** engine when none is asked for: FLOOD_ENGINE=js|wasm|auto in node (e.g. `FLOOD_ENGINE=js npm test`), else auto */
export function defaultEngine(): EngineChoice {
  const v = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.FLOOD_ENGINE;
  return isEngineChoice(v) ? v : 'auto';
}

interface KernelExports {
  setup(w: number, rows: number, nb: number, table: number): void;
  vertical(rainDepth: number, infBase: number, soilRec: number, cap: number, fold: number, A: number): number;
  wetExtents(): void;
  drainPonds(capDepth: number): number;
  route(dt: number, dx: number, A: number, kA: number, invDx: number, invA: number): number;
}

type Arr = Float64Array | Int32Array | Uint8Array;

let compiled: WebAssembly.Module | undefined; // failures are not cached: a later SimCore tries again
let lastError = '';

/** why the WebAssembly engine is unavailable ('' when it loaded, or was not tried yet) */
export function wasmError(): string {
  return lastError;
}

function surfaceModule(): WebAssembly.Module | null {
  if (compiled) return compiled;
  try {
    if (typeof WebAssembly !== 'object') throw new Error('WebAssembly is not available');
    const bin = atob(SURFACE_WASM);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    compiled = new WebAssembly.Module(bytes);
    return compiled;
  } catch (e) {
    lastError = String((e as Error)?.message ?? e);
    return null;
  }
}

const HEAD = 256; // bytes before the first array: the address table (surface.as.ts setup)
const ALIGN = 64;

export class SurfaceKernel {
  /** results the kernel cannot return directly (surface.as.ts: vertical ret[1..2], route ret[3..4]) */
  readonly ret: Float64Array;
  readonly x: KernelExports;

  private constructor(x: KernelExports, ret: Float64Array) {
    this.x = x;
    this.ret = ret;
  }

  /**
   * A kernel over a fresh memory holding copies of `arrays`, in the table order of surface.as.ts setup
   * (the last is the 8-slot result array). Returns the kernel and same-typed views over its memory that
   * replace the arrays, or null when WebAssembly is unavailable (wasmError() says why).
   */
  static create(arrays: Arr[], w: number, rows: number, nb: number): { kernel: SurfaceKernel; views: Arr[] } | null {
    const mod = surfaceModule();
    if (!mod) return null;
    try {
      if (typeof WebAssembly !== 'object') throw new Error('WebAssembly is not available');
      const offs: number[] = [];
      let end = HEAD;
      for (const a of arrays) {
        offs.push(end);
        end = Math.ceil((end + a.byteLength) / ALIGN) * ALIGN;
      }
      const pages = Math.max(1, Math.ceil(end / 65536));
      const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
      const inst = new WebAssembly.Instance(mod, { env: { memory, pow: Math.pow } });
      const buf = memory.buffer;
      const table = new Uint32Array(buf, 0, arrays.length);
      const views = arrays.map((a, k): Arr => {
        table[k] = offs[k];
        const v = a instanceof Float64Array ? new Float64Array(buf, offs[k], a.length) : a instanceof Int32Array ? new Int32Array(buf, offs[k], a.length) : new Uint8Array(buf, offs[k], a.length);
        v.set(a as ArrayLike<number>);
        return v;
      });
      const x = inst.exports as unknown as KernelExports;
      x.setup(w, rows, nb, 0);
      lastError = '';
      return { kernel: new SurfaceKernel(x, views[views.length - 1] as Float64Array), views };
    } catch (e) {
      lastError = String((e as Error)?.message ?? e);
      return null;
    }
  }
}
