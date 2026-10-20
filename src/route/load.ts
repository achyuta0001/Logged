// Fetch and decode the city road graph (public/data/roads/). index.json is small and names the
// content-addressed graph file (graph-<hash>.bin.gz), which GitHub Pages serves as is (no
// Content-Encoding): it is inflated here with the platform's DecompressionStream. Used by the router
// worker (./worker.ts) and by ./index.ts where workers are unavailable.
import { decodeGraph, gunzip } from './format.ts';
import { Router } from './router.ts';

/** public/data/roads/index.json, written by scripts/route/build-graph.mjs */
export interface RoadIndex {
  version: number;
  /** graph file name next to index.json */
  file: string;
  /** uncompressed and gzipped size of the graph file */
  bytes: number;
  gzipBytes: number;
  /** when the OSM extract was made */
  built: string;
  source: string;
  licence: string;
  bbox: number[];
  nodes: number;
  edges: number;
  landmarks: number;
  lengthKm?: number;
}

export type FetchFn = (url: string) => Promise<Response>;

/** not the file: an HTTP error, or the dev server's SPA fallback page (index.html for any unknown path) */
const missing = (r: Response) => !r.ok || (r.headers.get('content-type') ?? '').includes('text/html');

/** Load the graph under `base` (a folder URL ending in '/') and prepare a Router. */
export async function loadRouter(base: string, fetchFn: FetchFn = (u) => fetch(u)): Promise<{ router: Router; index: RoadIndex; ms: number }> {
  const t0 = performance.now();
  const ir = await fetchFn(`${base}index.json`);
  if (missing(ir)) throw new Error(`no road graph at ${base}index.json (build it with npm run data:roads)`);
  const index = (await ir.json()) as RoadIndex;
  const gr = await fetchFn(`${base}${index.file}`);
  if (missing(gr)) throw new Error(`${base}${index.file}: ${gr.ok ? 'missing' : `HTTP ${gr.status}`}`);
  const bytes = await gunzip(new Uint8Array(await gr.arrayBuffer()));
  const router = new Router(decodeGraph(bytes));
  return { router, index, ms: performance.now() - t0 };
}
