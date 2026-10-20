/// <reference lib="webworker" />
import { Runner, type RunnerInit } from './runner.ts';
import type { SimParams } from '../types.ts';

export type WorkerIn =
  | { type: 'init'; init: RunnerInit }
  | { type: 'run'; id: number; mm: number[]; params: SimParams };

export type WorkerOut =
  | { type: 'ready'; factor: number; engine: import('./kernel.ts').EngineKind }
  | { type: 'hour'; id: number; hour: number; total: number; frame: Uint16Array; stats: import('./core.ts').HourStats }
  | { type: 'done'; id: number; ms: number }
  | { type: 'error'; id?: number; message: string };

let runner: Runner | undefined;
const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      runner = new Runner(msg.init);
      ctx.postMessage({ type: 'ready', factor: runner.factor, engine: runner.engine } satisfies WorkerOut);
    } else if (msg.type === 'run') {
      if (!runner) throw new Error('worker not initialised');
      const t0 = performance.now();
      runner.run(msg.mm, msg.params, (r) => {
        ctx.postMessage({ type: 'hour', id: msg.id, ...r } satisfies WorkerOut, [r.frame.buffer]);
      });
      ctx.postMessage({ type: 'done', id: msg.id, ms: performance.now() - t0 } satisfies WorkerOut);
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', id: (msg as { id?: number }).id, message: String((err as Error)?.message ?? err) } satisfies WorkerOut);
  }
};
