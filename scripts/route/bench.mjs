// Benchmark and sanity check of the city-wide router on the built graph (public/data/roads/).
//
//   node scripts/route/bench.mjs [--dir public/data/roads] [--runs 15] [--pairs 300]
//
// Prints load times, then for four real commutes: time per request (fastest + 2 alternatives) and
// for the fastest route alone (median of --runs), nodes settled, road length vs the straight line
// (expect ~1.2-1.6x), typical peak-hour time and the alternatives' stretch and overlap. Last, A* with
// the landmark bounds is checked against plain Dijkstra on --pairs random trips: equal times prove
// the bounds admissible on the real graph.
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodeGraph } from '../../src/route/format.ts';
import { Router } from '../../src/route/router.ts';

const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.resolve(root, arg('dir', 'public/data/roads'));
const RUNS = Number(arg('runs', 15));
const PAIRS = Number(arg('pairs', 300));

export const COMMUTES = [
  ['Koramangala -> Manyata Tech Park', [77.6245, 12.9352], [77.6214, 13.0475]],
  ['Whitefield ITPL -> Silk Board', [77.7319, 12.9866], [77.6227, 12.9177]],
  ['Electronic City -> Hebbal', [77.66, 12.8452], [77.5911, 13.0381]],
  ['HSR Layout -> Bellandur ORR', [77.6387, 12.9116], [77.6762, 12.9279]],
];

const crow = (a, b) => Math.hypot((b[0] - a[0]) * 111320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180), (b[1] - a[1]) * 110574);
const median = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];

const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
const t0 = performance.now();
const raw = gunzipSync(fs.readFileSync(path.join(dir, index.file)));
const t1 = performance.now();
const g = decodeGraph(raw);
const t2 = performance.now();
const router = new Router(g);
const t3 = performance.now();
console.log(
  `graph ${index.file}: ${index.nodes} nodes, ${index.edges} edges, ${index.landmarks} landmarks, ${(index.gzipBytes / 1e6).toFixed(2)} MB gz / ${(index.bytes / 1e6).toFixed(2)} MB raw`,
);
console.log(`load: gunzip ${(t1 - t0).toFixed(0)} ms, decode ${(t2 - t1).toFixed(0)} ms, index ${(t3 - t2).toFixed(0)} ms`);

for (const [name, a, b] of COMMUTES) {
  const all = [], one = [];
  let res = [], settled = 0;
  for (let i = 0; i < RUNS; i++) {
    let s = performance.now();
    res = router.route(a, b);
    all.push(performance.now() - s);
    settled = router.lastStats.settled;
    s = performance.now();
    router.route(a, b, { alternatives: 1 });
    one.push(performance.now() - s);
  }
  const single = router.lastStats.settled;
  const c = crow(a, b);
  console.log(`\n${name}: straight line ${(c / 1000).toFixed(1)} km`);
  console.log(`  ${median(one).toFixed(1)} ms fastest only (${single} settled), ${median(all).toFixed(1)} ms with alternatives (${settled} settled)`);
  const A = res[0];
  for (const r of res) {
    const ratio = r.lengthM / c;
    const shared = r === A ? '' : `, shares ${Math.round((100 * sharedM(r, A)) / r.lengthM)} % with A`;
    const ok = r === A ? (ratio >= 1.15 && ratio <= 1.7 ? 'ok' : 'CHECK') : '';
    console.log(
      `  ${r.id} ${(r.lengthM / 1000).toFixed(1)} km (${ratio.toFixed(2)}x ${ok}) ${Math.round(r.durationS / 60)} min${r === A ? '' : ` (${(r.durationS / A.durationS).toFixed(2)}x A)`}${shared} ${r.via}`,
    );
  }
}

/** metres of r on the same OSM ways as q (way-level, so an approximation) */
function sharedM(r, q) {
  const ids = new Set(q.ways.map((w) => w.id));
  let s = 0;
  r.ways.forEach((w, k) => {
    const end = k + 1 < r.ways.length ? r.ways[k + 1].i : r.line.length - 1;
    if (ids.has(w.id)) s += r.cumM[end] - r.cumM[w.i];
  });
  return s;
}

// A* (landmarks + straight line) against Dijkstra on random trips across the district
const plain = new Router(g, { heuristic: false });
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const [w, s, e, n] = [77.42, 12.78, 77.76, 13.14];
let worst = 0, astarMs = 0, dijMs = 0, aSet = 0, dSet = 0, tried = 0;
for (let i = 0; i < PAIRS; i++) {
  const p = [w + rnd() * (e - w), s + rnd() * (n - s)], q = [w + rnd() * (e - w), s + rnd() * (n - s)];
  const sp = router.snap(p), sq = router.snap(q);
  if (!sp || !sq) continue;
  let t = performance.now();
  const x = router.search(sp, sq, null, null, 0);
  astarMs += performance.now() - t;
  t = performance.now();
  const y = plain.search(sp, sq, null, null, 0);
  dijMs += performance.now() - t;
  if (!x || !y) throw new Error(`pair ${i}: A* ${!!x}, Dijkstra ${!!y}`);
  worst = Math.max(worst, Math.abs(x.cost - y.cost));
  aSet += x.settled;
  dSet += y.settled;
  tried++;
}
console.log(
  `\nA* vs Dijkstra on ${tried} random trips: largest time difference ${worst.toExponential(1)} s; A* ${(astarMs / tried).toFixed(1)} ms / ${Math.round(aSet / tried)} settled, Dijkstra ${(dijMs / tried).toFixed(1)} ms / ${Math.round(dSet / tried)} settled per trip`,
);
if (worst > 1e-6) {
  console.error('A* and Dijkstra disagree: the landmark bounds are not admissible');
  process.exit(1);
}
