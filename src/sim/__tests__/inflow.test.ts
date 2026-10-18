// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Run: node --test src/sim/__tests__/   (Node >= 22.6 strips TS types natively; no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimCore } from '../core.ts';
import { Inflow, inflowExcess, inflowHydrograph } from '../inflow.ts';
import { noisyTerrain } from './synthetic.ts';
import { gridOf, injectionCell, outsideInflow, packInflow } from '../../../scripts/lib/catchment.mjs';

const P = { drainCapacityMmHr: 50, infiltrationMmHr: 10, drainBlockage: 0.4 }; // 30 mm/h effective drains
const point = (extra = {}) => ({ cell: 0, at: [77.6, 12.9], areaKm2: 1, impervious: 1, drainShare: 1, timeArea: [1], ...extra });
const sum = (a) => a.reduce((s, v) => s + v, 0);

test('inflow excess: the grid’s losses first, then the rest runs off', () => {
  // sealed, fully served: 30 mm/h of drains; 40 mm/h of rain leaves 10 mm over 1 km² = 10 000 m³
  assert.deepEqual([...inflowExcess(point(), [20, 30, 40], P)].map(Math.round), [0, 0, 10000]);
  // half pervious: infiltration (10 mm/h on half the area) comes off too
  assert.equal(Math.round(inflowExcess(point({ impervious: 0.5 }), [40], P)[0]), 5000);
  // far from mapped drains only the 30 % roadside share acts (9 mm/h): more runs off
  assert.ok(inflowExcess(point({ drainShare: 0 }), [20], P)[0] > 10000);
  // the drain controls act on it: fully blocked drains pass everything
  assert.equal(Math.round(inflowExcess(point(), [40], { ...P, drainBlockage: 1 })[0]), 40000);
});

test('inflow excess: tanks hold their flood cushion before passing water on', () => {
  const ex = inflowExcess(point({ tankShare: 1, tankM3: 15000 }), [40, 40, 40], P); // 10 000 m³ per hour arrive
  assert.deepEqual([...ex].map(Math.round), [0, 5000, 10000]);
  // only the share draining through tanks is held
  const half = inflowExcess(point({ tankShare: 0.5, tankM3: 1e9 }), [40], P);
  assert.equal(Math.round(half[0]), 5000);
});

test('inflow hydrograph: translation by the time-area histogram, attenuation, and no volume made or lost', () => {
  const mm = [40, 0, 0, 0, 0, 0];
  assert.deepEqual([...inflowHydrograph(point({ timeArea: [0, 1] }), mm, P)].map(Math.round), [0, 10000, 0, 0, 0, 0]);
  const split = inflowHydrograph(point({ timeArea: [0.25, 0.5, 0.25] }), mm, P);
  assert.deepEqual([...split].map(Math.round), [2500, 5000, 2500, 0, 0, 0]);
  // Clark reservoir lowers and delays the peak; over a long dry tail everything arrives
  const long = [40, 40, ...new Array(60).fill(0)];
  const plain = inflowHydrograph(point({ timeArea: [0.5, 0.5] }), long, P);
  const clark = inflowHydrograph(point({ timeArea: [0.5, 0.5], storageH: 1.5 }), long, P);
  assert.ok(Math.max(...clark) < 0.8 * Math.max(...plain), 'reservoir attenuates the peak');
  assert.ok(clark.indexOf(Math.max(...clark)) >= plain.indexOf(Math.max(...plain)));
  assert.ok(Math.abs(sum(clark) - 20000) < 1e-6 * 20000 && Math.abs(sum(plain) - 20000) < 1e-9, `volume ${sum(clark)} / ${sum(plain)}`);
  // nothing flows in a dry series
  assert.equal(sum(inflowHydrograph(point({ storageH: 2 }), [0, 0, 0], P)), 0);
});

test('core point sources conserve mass and are booked as inflow', () => {
  const g = noisyTerrain(120, 140);
  const s = new SimCore(g, { drainCapacityMmHr: 20, infiltrationMmHr: 10, drainBlockage: 0.3 });
  const cell = 70 * 120 + 60;
  let injected = 0;
  for (const [mm, q] of [[10, 0], [40, 5], [20, 12], [0, 8], [0, 2], [0, 0]]) {
    s.sources = q ? { cells: Int32Array.of(cell, cell + 1), m3s: Float64Array.of(q, q / 2) } : null;
    const st = s.stepHour(mm);
    assert.ok(Math.abs(st.inflowM3 - q * 1.5 * 3600) < 1e-6 * (q + 1) * 3600, `hour inflow ${st.inflowM3}`);
    injected += q * 1.5 * 3600;
  }
  const b = s.budget;
  assert.ok(Math.abs(b.inflow - injected) < 1e-6 * injected);
  const err = Math.abs(b.rain + b.inflow - b.infiltrated - b.drained - b.lake - b.outflow - s.totalVolume()) / (b.rain + b.inflow);
  assert.ok(err < 1e-9, `relative budget error ${err}`);
  // a dry hour on an empty grid still takes inflow (it is not skipped as quiescent)
  const e = new SimCore(g, { drainCapacityMmHr: 0, infiltrationMmHr: 0, drainBlockage: 0 });
  e.sources = { cells: Int32Array.of(cell), m3s: Float64Array.of(1) };
  assert.ok(Math.abs(e.stepHour(0).inflowM3 - 3600) < 1e-6 && e.totalVolume() > 0);
});

test('Inflow maps fine cells onto the coarse grid; FloodEngine routes meta.inflow in', async () => {
  const fl = new Inflow([point({ cell: 5 * 90 + 7 }), point({ cell: 10 ** 9 }), point({ areaKm2: 0 })], 90, 90 * 110, 2, 45);
  assert.equal(fl.size, 1, 'invalid points are dropped');
  assert.equal(fl.cells[0], 2 * 45 + 3);
  fl.prepare([40, 0], P);
  assert.equal(fl.sourcesAt(1), null);
  assert.ok(Math.abs(fl.sourcesAt(0).m3s[0] - 10000 / 3600) < 1e-9);
  // the point sits at coarse (2, 3), near the north-west corner: 1 km² -> +-150 m = +-5 cells at 30 m on
  // both nearby edges (north row 0, cols 0..8; west col 0, rows 0..7)
  const closed = new Set(fl.edgeCells(55, 30));
  for (let c = 0; c <= 8; c++) assert.ok(closed.has(c), `north edge col ${c}`);
  for (let r = 0; r <= 7; r++) assert.ok(closed.has(r * 45), `west edge row ${r}`);
  assert.equal(closed.size, 9 + 7);
  assert.ok(!closed.has(9) && !closed.has(8 * 45) && !closed.has(54 * 45), 'south edge and the rest stay open');
  // a closed edge keeps water that would otherwise drain out of it
  const tilt = { width: 20, height: 20, cellSizeM: 30, elevation: Float32Array.from({ length: 400 }, (_, i) => 900 + Math.floor(i / 20) * 0.3), impervious: new Float32Array(400).fill(1) };
  const outflow = (close) => {
    const s = new SimCore(tilt, { drainCapacityMmHr: 0, infiltrationMmHr: 0, drainBlockage: 0 });
    if (close) s.closeEdges(Int32Array.from({ length: 20 }, (_, c) => c)); // north edge (the low side)
    s.sources = { cells: Int32Array.of(2 * 20 + 10), m3s: Float64Array.of(2) };
    s.stepHour(0);
    return s.budget.outflow;
  };
  assert.ok(outflow(true) < 0.5 * outflow(false), `closed ${outflow(true)} vs open ${outflow(false)}`);

  const { FloodEngine } = await import('../index.ts');
  const g = noisyTerrain(90, 110);
  const grids = { elevation: g.elevation, impervious: g.impervious, drainMask: g.drainMask, lakeMask: g.lakeMask, boundaryMask: g.boundaryMask };
  const series = { source: 'scenario', label: 't', times: [0, 1, 2, 3].map((i) => i * 3.6e6), mm: [10, 40, 0, 0] };
  const run = async (inflow) => {
    const eng = await FloodEngine.create({ meta: { width: 90, height: 110, cellSizeM: 15, inflow }, grids }, P, { inline: true });
    await eng.run(series);
    return eng;
  };
  const pt = point({ cell: 55 * 90 + 45, areaKm2: 2, timeArea: [0.5, 0.5] });
  const withIn = await run([pt]);
  const without = await run(undefined);
  const want = sum(inflowHydrograph(pt, series.mm, P));
  const got = sum(withIn.hourStats.map((h) => h.inflowM3));
  assert.ok(want > 0 && Math.abs(got - want) < 1e-6 * want, `inflow ${got} vs ${want}`);
  assert.equal(sum(without.hourStats.map((h) => h.inflowM3)), 0);
  assert.ok(withIn.snapshot(3).totalVolumeM3 > without.snapshot(3).totalVolumeM3);
});

/** synthetic district: a plane falling east, every cell draining east (D8 0) */
function plane(W = 30, H = 20) {
  const G = gridOf({ w: 77, n: 13, width: W, height: H, dLat: 60 / 110574, dLon: 60 / 108500, cellM: 60 });
  const N = W * H;
  const dir = new Uint8Array(N), acc = new Float32Array(N), dem = new Float32Array(N), imp = new Float32Array(N).fill(0.6);
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      dir[i] = c === W - 1 ? 255 : 0;
      acc[i] = c + 1;
      dem[i] = 900 - c * 0.3; // 0.5 % slope
    }
  const lake = new Uint8Array(N);
  lake[12 * W + 3] = 1; // a tank on the row 12 path
  return { G, dir, acc, dem, imp, lake, drain: new Uint8Array(N) };
}

test('catchment: paths entering the bbox from outside, outside cells only, with travel times', () => {
  const flow = plane();
  const { G } = flow;
  const bb = [G.w + 10 * G.dLon, G.n - 15 * G.dLat, G.w + 20 * G.dLon, G.n - 5 * G.dLat]; // cols 10-19, rows 5-14
  const r = outsideInflow(flow, bb);
  assert.equal(r.points.length, 10, 'one crossing per row on the west edge');
  assert.ok(Math.abs(r.totalKm2 - 10 * 10 * 0.0036) < 1e-9, `total ${r.totalKm2}`);
  for (const p of r.points) {
    assert.ok(Math.abs(p.areaKm2 - 0.036) < 1e-9);
    assert.ok(Math.abs(sum(p.timeArea) - 1) < 1e-2);
    assert.ok(p.lon > bb[0] && p.lon < bb[0] + G.dLon, 'reported at the first cell inside');
    assert.equal(p.impervious.toFixed(3), '0.600');
    assert.equal(p.drainShare, 1, 'no mapped drains anywhere: capacity acts everywhere');
  }
  const tank = r.points.find((p) => p.tankM3 > 0);
  assert.ok(tank && Math.abs(tank.tankShare - 0.4) < 1e-9, 'cells upstream of the tank (cols 0-3) pass it');
  // nothing enters from the east (water leaves that way)
  assert.ok(r.points.every((p) => p.lon < bb[0] + G.dLon));
});

test('catchment: injection cells sit on the pack’s flow path, clear of the edges', () => {
  const W = 40, H = 40;
  const flowDir = new Uint8Array(W * H).fill(0), flowAccum = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) flowAccum[i] = (i % W) + 1 + (((i / W) | 0) === 20 ? 100 : 0); // a stream along row 20
  const cell = injectionCell({ width: W, height: H }, flowDir, flowAccum, 0.5, 22.5);
  assert.equal((cell / W) | 0, 20, 'snapped to the stream');
  assert.ok(cell % W >= 6, `inset from the west edge: col ${cell % W}`);
  // the pack grid as a finer copy of the bbox: every crossing becomes a point, all area simulated
  const flow = plane();
  const { G } = flow;
  const grid = gridOf({ w: G.w + 10 * G.dLon, n: G.n - 5 * G.dLat, width: 40, height: 40, dLat: G.dLat / 4, dLon: G.dLon / 4, cellM: 15 });
  const fd = new Uint8Array(1600).fill(0), fa = new Float32Array(1600).map((_, i) => (i % 40) + 1);
  const pk = packInflow(flow, grid, fd, fa, { minKm2: 0 });
  assert.ok(Math.abs(pk.simulatedKm2 - pk.totalKm2) < 0.02 && pk.points.length >= 1);
  for (const p of pk.points) assert.ok(p.cell % 40 >= 6 && p.cell >= 0 && p.cell < 1600);
});
