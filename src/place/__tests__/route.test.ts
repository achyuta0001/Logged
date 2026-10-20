// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Run: node --test src/place/__tests__/   (Node >= 22.6 strips TS types natively; no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildRoadGraph, nearest, route } from '../route.ts';
import { cellAt } from '../geo.ts';
import { terrainFromBuffer } from '../../terrain.ts';
import { deriveOsmCells } from '../../pack/osm.ts';

// ~1.1 km square grid of 110 x 110 cells (~10 m)
const W = 110;
const meta = {
  pincode: 'test',
  name: 'Synthetic',
  bbox: [77.5, 12.9, 77.51, 12.91],
  width: W,
  height: W,
  cellSizeM: 10,
  boundary: { type: 'Polygon', coordinates: [] },
  layers: {},
  stats: { minElev: 0, maxElev: 1 },
  sources: [],
};

const road = (id, name, coords, highway = 'residential') => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: coords },
  properties: { id, kind: 'road', name, highway, cell: 0 },
});

// A ---- direct ---- B   with a detour A -> C -> D -> B to the north
const A = [77.501, 12.905];
const B = [77.509, 12.905];
const C = [77.501, 12.908];
const D = [77.509, 12.908];
const osm = {
  type: 'FeatureCollection',
  features: [
    road('way/1', 'Direct Road', [A, [77.505, 12.905], B]),
    road('way/2', 'West Lane', [A, C]),
    road('way/3', 'North Lane', [C, D]),
    road('way/4', 'East Lane', [D, B]),
  ],
};

/** depth grid with `m` metres of water in a disc of `r` cells around each point */
function flood(points, m, r = 4) {
  const d = new Float32Array(W * W);
  for (const p of points) {
    const c = cellAt(meta, p[0], p[1]);
    const x0 = c % W;
    const y0 = Math.floor(c / W);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) d[(y0 + dy) * W + x0 + dx] = m;
  }
  return d;
}

const g = buildRoadGraph(osm, meta);

test('dry day: takes the direct road', () => {
  const r = route(g, null, A, B, 'car');
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.lengthM - 868) < 30, `length ${r.lengthM}`);
  assert.ok(r.via.includes('Direct Road'));
  assert.equal(r.blocked, undefined);
});

test('flooded direct road: detours north and reports the usual route', () => {
  const depth = flood([[77.505, 12.905]], 0.5);
  const r = route(g, depth, A, B, 'two_wheeler');
  assert.equal(r.ok, true);
  assert.ok(r.lengthM > 1400, `detour length ${r.lengthM}`);
  assert.ok(r.via.includes('North Lane'));
  assert.ok(r.usual, 'usual route attached');
  assert.ok(r.blocked && r.blocked.depthM >= 0.45, 'blockage on the usual route');
  assert.equal(r.blocked.roadName, 'Direct Road');
});

test('shallow water: car still goes direct, walking still passes', () => {
  const depth = flood([[77.505, 12.905]], 0.2);
  const car = route(g, depth, A, B, 'car');
  assert.equal(car.ok, true);
  assert.ok(car.lengthM < 1000);
  assert.ok(car.wetLengthM > 0);
  const walk = route(g, depth, A, B, 'walk');
  assert.equal(walk.ok, true);
});

test('fully blocked: returns the dry-weather route with its first blockage', () => {
  const depth = flood([[77.505, 12.905], [77.505, 12.908]], 0.8);
  const r = route(g, depth, A, B, 'car');
  assert.equal(r.ok, false);
  assert.ok(r.blocked, 'blockage reported');
  assert.ok(Math.abs(r.lengthM - 868) < 30, `dry route length ${r.lengthM}`);
  assert.ok(r.segments.some((s) => s.state === 'blocked'));
});

test('real data smoke test (560098): route between two named roads and to the nearest hospital', () => {
  const root = new URL('../../../public/data/pins/560098/', import.meta.url);
  let m;
  try {
    m = JSON.parse(readFileSync(new URL('meta.json', root), 'utf8'));
  } catch {
    return; // pack not present (e.g. a sparse checkout)
  }
  const buf = readFileSync(new URL('grids.bin', root));
  const t = terrainFromBuffer(m, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  // format 2: stored gzipped, without the per-feature cells (rebuilt as the app does on load)
  const real = JSON.parse(gunzipSync(readFileSync(new URL('osm.geojson.gz', root))).toString('utf8'));
  deriveOsmCells(real, t.meta);
  const rg = buildRoadGraph(real, t.meta);
  assert.ok(rg.stats.edges > 1000, `edges ${rg.stats.edges}`);
  const pick = (re) => {
    const f = real.features.find((x) => x.properties.kind === 'road' && re.test(x.properties.name ?? '') && x.geometry.type === 'LineString');
    assert.ok(f, `road ${re}`);
    const cs = f.geometry.coordinates;
    return cs[Math.floor(cs.length / 2)];
  };
  const from = pick(/^Kenchenahalli Main Road$/);
  const to = pick(/^Dr. Vishnuvardhan Road$/);
  const r = route(rg, null, from, to, 'car');
  assert.equal(r.ok, true, `error ${r.error}`);
  assert.ok(r.lengthM > 100 && r.lengthM < 20000, `length ${r.lengthM}`);
  const h = nearest(rg, null, from, 'hospital', 'car', real);
  assert.ok(h && h.route.ok, 'a hospital is reachable on a dry day');
});
