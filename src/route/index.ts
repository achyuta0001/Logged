// City-wide car routing for the Commute tab: the fastest route between two points anywhere in
// Bengaluru Urban, plus up to two distinct alternatives, optionally kept off flooded hotspots.
//
//   preloadRoutes();                                         // when the Commute tab opens (optional)
//   const routes = await planRoutes(home, office);           // RoutedCandidate[]: 'A' fastest, 'B', 'C'
//   const dry = await planRoutes(home, office, { avoid: hotspot.ways });
//
// RoutedCandidate is the contract's RouteCandidate (src/commute/types.ts) plus `ways` (OSM way ids
// along the route, each with the line index where it starts: atS = cumS[i]) and `cumM`.
// [] means a point is more than 1.5 km from any drivable road, or no route exists.
//
// The graph (public/data/roads/, ~6.5 MB gzipped, scripts/route/build-graph.mjs) is fetched once, on
// first use, into a worker (./worker.ts); the service worker keeps it across visits. A request takes
// a few ms there once the graph is loaded. Where Worker is missing, it all runs in this thread.
import type { LngLat } from '../commute/spots.ts';
import type { RoadIndex } from './load.ts';
import type { Router, RoutedCandidate, RouteOptions } from './router.ts';
import type { RouteWorkerIn, RouteWorkerOut } from './worker.ts';

export type { RoadIndex } from './load.ts';
export type { RoutedCandidate, RouteOptions, RouteWay } from './router.ts';

/** Absolute URL of the folder holding the road graph (the worker resolves URLs against its own file). */
export function roadsBase(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const base = (env?.BASE_URL ?? '/').replace(/\/?$/, '/');
  return new URL(`${base}data/roads/`, globalThis.location?.href ?? 'http://localhost/').href;
}

type Reply = Exclude<RouteWorkerOut, { type: 'error' }>;
const pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
let worker: Worker | null = null;
let ready: Promise<RoadIndex> | null = null;
let local: Promise<{ router: Router; index: RoadIndex }> | null = null;
let seq = 0;

function post(msg: RouteWorkerIn): Promise<Reply> {
  return new Promise((resolve, reject) => {
    if (!worker) return reject(new Error('router worker stopped'));
    pending.set(msg.id, { resolve, reject });
    worker.postMessage(msg);
  });
}

function spawn(): Worker {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (ev: MessageEvent<RouteWorkerOut>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.type === 'error') p.reject(new Error(ev.data.message));
    else p.resolve(ev.data);
  };
  w.onerror = (ev) => {
    ev.preventDefault();
    const err = new Error(ev.message || 'router worker failed');
    disposeRoutes(err);
  };
  return w;
}

/** Start loading the road graph (once). Resolves with its index; a failed load can be retried. */
export function preloadRoutes(): Promise<RoadIndex> {
  if (ready) return ready;
  let p: Promise<RoadIndex>;
  if (typeof Worker === 'undefined') {
    local = import('./load.ts').then((m) => m.loadRouter(roadsBase()));
    p = local.then((l) => l.index);
  } else {
    worker = spawn();
    p = post({ type: 'init', id: ++seq, base: roadsBase() }).then((r) => (r as Extract<Reply, { type: 'ready' }>).index);
  }
  ready = p;
  p.catch(() => {
    if (ready === p) disposeRoutes();
  });
  return p;
}

/**
 * The fastest route from `from` to `to` ([lon, lat]) and up to `alternatives - 1` distinct others
 * (each shares at most 75 % of its length with the ones before and takes at most 1.4x the fastest).
 * `avoid`: OSM way ids to route around; they are still used when no detour under an hour exists.
 */
export async function planRoutes(from: LngLat, to: LngLat, opts: RouteOptions = {}): Promise<RoutedCandidate[]> {
  await preloadRoutes();
  const o = { alternatives: opts.alternatives, avoidPenaltyS: opts.avoidPenaltyS, avoid: opts.avoid ? [...opts.avoid].map(Number) : undefined };
  if (local) return (await local).router.route(from, to, o);
  const r = await post({ type: 'route', id: ++seq, from, to, opts: o });
  return (r as Extract<Reply, { type: 'routes' }>).routes;
}

/** Stop the worker and drop the graph (the next call loads it again). */
export function disposeRoutes(err: Error = new Error('router stopped')): void {
  worker?.terminate();
  worker = null;
  ready = null;
  local = null;
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}
