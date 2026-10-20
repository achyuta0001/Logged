// @ts-nocheck -- node:test types are not part of the browser tsconfig
// The WebAssembly surface step (src/sim/wasm/surface.as.ts via src/sim/kernel.ts) against the JS step it
// mirrors: bit-identical depths, budgets and stats; the JS fallback; the engine option; and the embedded
// module being what its source compiles to. `FLOOD_ENGINE=js npm test` runs every other suite on JS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SimCore } from '../core.ts';
import { bowlAndChannel, noisyTerrain } from './synthetic.ts';

/** both engines on the same grid; `drive(core, hour)` runs one hour (sources, edges, rain) */
function pair(g, params, drive, hours) {
  const out = {};
  for (const engine of ['js', 'wasm']) {
    const s = new SimCore(g, params, { engine });
    assert.equal(s.engine, engine);
    const stats = [];
    for (let k = 0; k < hours; k++) stats.push(drive(s, k));
    out[engine] = { s, stats };
  }
  return out;
}

/** every value equal bit for bit (Object.is: +0 / -0 and NaN too) */
function sameBits(a, b, what) {
  assert.equal(a.length, b.length, `${what}: length`);
  let diff = 0, first = -1;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) { diff++; if (first < 0) first = i; }
  assert.equal(diff, 0, `${what}: ${diff} values differ (first at ${first}: ${a[first]} vs ${b[first]})`);
}

function assertIdentical({ js, wasm }) {
  sameBits(js.s.h, wasm.s.h, 'depth');
  assert.deepEqual(wasm.s.budget, js.s.budget);
  assert.deepEqual(wasm.stats, js.stats);
  if (js.s.net) {
    assert.deepEqual(wasm.s.net.totals, js.s.net.totals);
    sameBits(js.s.net.S, wasm.s.net.S, 'drain storage');
  }
  assert.deepEqual(wasm.s.lakeStatus(), js.s.lakeStatus());
}

test('wasm = js, bit for bit: drains, tanks, soil, pond drainage, inflow and closed edges', () => {
  const g = noisyTerrain(90, 120);
  const P = { drainCapacityMmHr: 40, infiltrationMmHr: 12, drainBlockage: 0.3 };
  const rain = [5, 30, 60, 25, 2, 0, 0, 0, 0, 0];
  const r = pair(g, P, (s, k) => {
    if (k === 0) s.closeEdges(Int32Array.from({ length: 90 }, (_, c) => (120 - 1) * 90 + c)); // south edge
    s.setEdgesClosed(k < 4);
    s.sources = k < 5 ? { cells: Int32Array.of(118 * 90 + 40, 60 * 90 + 2), m3s: Float64Array.of(3, 0.5) } : null;
    return s.stepHour(rain[k]);
  }, rain.length);
  assert.ok(r.js.s.budget.drained > 0 && r.js.s.budget.inflow > 0 && r.js.s.budget.outflow > 0);
  assert.ok(r.js.s.net && r.js.s.net.totals.surcharge >= 0, 'the grid has a drain network');
  assert.ok(r.js.s.lakeStatus().some((l) => l.freeM3 < l.capacityM3), 'a tank took water'); // booked by the network
  assertIdentical(r);
});

test('wasm = js, bit for bit: no losses, closed bowl, long recession steps', () => {
  const g = bowlAndChannel(80);
  assertIdentical(pair(g, { drainCapacityMmHr: 0, infiltrationMmHr: 0, drainBlockage: 0 }, (s, k) => s.stepHour([40, 70, 0, 0, 0, 0, 0, 0][k]), 8));
  // without mapped drains the inlets are plain sinks and pond drainage runs on every basin
  assertIdentical(pair(g, { drainCapacityMmHr: 25, infiltrationMmHr: 5, drainBlockage: 0 }, (s, k) => s.stepHour([60, 10, 0, 0, 0, 0][k]), 6));
});

test('wasm = js, bit for bit: water over 5 m deep (Math.pow branch) at faces and at the grid edge', () => {
  const w = 24, H = 20, n = w * H;
  const elevation = new Float32Array(n);
  for (let r = 0; r < H; r++) for (let c = 0; c < w; c++) elevation[r * w + c] = 900 + 0.05 * c + 0.03 * r - (Math.abs(r - 10) < 3 && Math.abs(c - 12) < 3 ? 8 : 0);
  const g = { width: w, height: H, cellSizeM: 15, elevation, impervious: new Float32Array(n).fill(0.7) };
  const r = pair(g, { drainCapacityMmHr: 0, infiltrationMmHr: 0, drainBlockage: 0 }, (s, k) => {
    if (k === 0) {
      for (let i = 0; i < n; i++) s.h[i] = 900 + 7.5 - s.z[i] > 0 ? Math.min(7.5, 900 + 7.5 - s.z[i]) : 0.05;
      s.h[0] = 6; // an edge cell deeper than 5 m
    }
    return s.stepHour(k ? 0 : 20);
  }, 3);
  assert.ok(r.js.stats[0].maxDepthM > 5);
  assertIdentical(r);
});

test('wasm = js, bit for bit: the 560071 pack through the 2024 storm peak (FloodEngine, frames and stats)', async () => {
  const dir = new URL('../../../public/data/pins/560071/', import.meta.url);
  if (!fs.existsSync(new URL('grids.bin', dir))) return; // pack not present
  const { terrainFromBuffer } = await import('../../terrain.ts');
  const { FloodEngine } = await import('../index.ts');
  const { SCENARIOS } = await import('../../weather.ts');
  const meta = JSON.parse(fs.readFileSync(new URL('meta.json', dir), 'utf8'));
  const buf = fs.readFileSync(new URL('grids.bin', dir));
  const terrain = terrainFromBuffer(meta, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const storm = SCENARIOS.find((s) => s.id === 'rrnagar-2024-10-20').build();
  let peak = 0;
  storm.mm.forEach((v, i) => { if (v > storm.mm[peak]) peak = i; });
  const series = { ...storm, mm: storm.mm.slice(Math.max(0, peak - 2), peak + 2) };
  const runs = {};
  for (const engine of ['js', 'wasm']) {
    const e = await FloodEngine.create(terrain, {}, { inline: true, engine });
    assert.equal(e.engine, engine);
    await e.run(series);
    runs[engine] = e;
  }
  assert.deepEqual(runs.wasm.hourStats, runs.js.hourStats);
  for (let k = 0; k < runs.js.hours; k++) sameBits(runs.js.snapshot(k).depth, runs.wasm.snapshot(k).depth, `hour ${k}`);
  assert.ok(runs.js.hourStats.some((s) => s.floodedAreaM2 > 0));
});

test('engine choice: auto runs WebAssembly, js the fallback; without WebAssembly auto falls back and wasm fails', () => {
  const g = bowlAndChannel(40);
  assert.equal(new SimCore(g).engine, process.env.FLOOD_ENGINE === 'js' ? 'js' : 'wasm');
  assert.equal(new SimCore(g, {}, { engine: 'auto' }).engine, 'wasm');
  assert.equal(new SimCore(g, {}, { engine: 'js' }).engine, 'js');
  const WA = globalThis.WebAssembly;
  try {
    globalThis.WebAssembly = undefined;
    const s = new SimCore(g, {}, { engine: 'auto' });
    assert.equal(s.engine, 'js');
    s.stepHour(90); // well over the default 30 mm/h of effective drains
    assert.ok(s.totalVolume() > 0);
    assert.throws(() => new SimCore(g, {}, { engine: 'wasm' }), /WebAssembly/);
  } finally {
    globalThis.WebAssembly = WA;
  }
  assert.equal(new SimCore(g, {}, { engine: 'auto' }).engine, 'wasm', 'recovers once WebAssembly is back');
});

test('the embedded module is what surface.as.ts compiles to (else: npm run wasm)', async (t) => {
  let build;
  try {
    build = await import('../../../scripts/build-wasm.mjs');
    await import('assemblyscript/asc');
  } catch {
    t.skip('assemblyscript (devDependency) is not installed');
    return;
  }
  const { expected, actual } = await build.expectedModuleText();
  assert.ok(expected === actual, 'src/sim/wasm/surface.bin.ts is out of date with surface.as.ts: run npm run wasm');
});
