/// <reference lib="webworker" />
// Router worker: holds the decoded city road graph (~60–80 MB of typed arrays) off the main thread
// and answers route requests. Driven by ./index.ts.
import type { LngLat } from '../commute/spots.ts';
import { loadRouter, type RoadIndex } from './load.ts';
import type { RoutedCandidate, Router, RouteOptions } from './router.ts';

export type RouteWorkerIn =
  | { type: 'init'; id: number; base: string }
  | { type: 'route'; id: number; from: LngLat; to: LngLat; opts: Omit<RouteOptions, 'avoid'> & { avoid?: number[] } };

export type RouteWorkerOut =
  | { type: 'ready'; id: number; index: RoadIndex; ms: number }
  | { type: 'routes'; id: number; routes: RoutedCandidate[]; ms: number; settled: number }
  | { type: 'error'; id: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let loading: Promise<{ router: Router; index: RoadIndex; ms: number }> | null = null;

ctx.onmessage = async (e: MessageEvent<RouteWorkerIn>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      loading ??= loadRouter(msg.base);
      const { index, ms } = await loading;
      ctx.postMessage({ type: 'ready', id: msg.id, index, ms } satisfies RouteWorkerOut);
    } else if (msg.type === 'route') {
      if (!loading) throw new Error('router worker not initialised');
      const { router } = await loading;
      const routes = router.route(msg.from, msg.to, msg.opts);
      ctx.postMessage({ type: 'routes', id: msg.id, routes, ms: router.lastStats.ms, settled: router.lastStats.settled } satisfies RouteWorkerOut);
    }
  } catch (err) {
    if (msg.type === 'init') loading = null; // the next init retries
    ctx.postMessage({ type: 'error', id: msg.id, message: String((err as Error)?.message ?? err) } satisfies RouteWorkerOut);
  }
};
