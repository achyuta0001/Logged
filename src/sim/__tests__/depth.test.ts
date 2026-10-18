// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Depth sanity: closed street depressions are capped (grid.ts limitPits, runner.ts PIT_MAX_M) and inflow
// edges reopen once the inflow has receded (core.ts setEdgesClosed, runner.ts EDGE_OPEN_SHARE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimCore } from '../core.ts';
import { limitPits } from '../grid.ts';
import { Runner, PIT_MAX_M } from '../runner.ts';

const P = { drainCapacityMmHr: 0, infiltrationMmHr: 0, drainBlockage: 0 };

/** flat 20 x 20 ground at 900 m with a 3 x 3 pit `deep` m deep in the middle */
function pitGrid(deep = 6) {
  const w = 20, h = 20, z = new Float32Array(w * h).fill(900);
  for (let r = 9; r <= 11; r++) for (let c = 9; c <= 11; c++) z[r * w + c] = 900 - deep;
  return { w, h, z };
}

test('limitPits caps closed depressions below their spill level, leaves outlets, shallow dips and walls alone', () => {
  const { w, h, z } = pitGrid(6);
  z[3 * w + 3] = 899.2; // a 0.8 m road dip
  z[15 * w + 15] = 893; // a tank cell (outlet): stays as deep as it is
  z[5 * w + 15] = NaN; // no data: a wall
  const out = new Uint8Array(w * h);
  out[15 * w + 15] = 1;
  const raised = limitPits(z, w, h, 2, out);
  assert.equal(raised, 9, 'the nine pit cells');
  for (let r = 9; r <= 11; r++) for (let c = 9; c <= 11; c++) assert.equal(z[r * w + c], 898, 'pit floor at spill - 2 m');
  assert.ok(Math.abs(z[3 * w + 3] - 899.2) < 1e-4, 'a dip shallower than the cap is kept');
  assert.equal(z[15 * w + 15], 893, 'outlets are never raised');
  assert.ok(Number.isNaN(z[5 * w + 15]), 'walls stay walls');
  // a pit that drains to an outlet is not closed: nothing to cap
  const b = pitGrid(6);
  const o2 = new Uint8Array(b.w * b.h);
  o2[10 * b.w + 10] = 1; // a mapped drain at the bottom of the pit
  assert.equal(limitPits(b.z, b.w, b.h, 2, o2), 0);
  // a pit whose rim is lower on one side spills there: the cap follows the spill level, not the highest rim
  const c = pitGrid(6);
  for (let r = 0; r <= 8; r++) c.z[r * c.w + 10] = 897; // a channel-like cut from the north edge to the pit
  limitPits(c.z, c.w, c.h, 2);
  assert.equal(c.z[10 * c.w + 10], 895, 'spill at 897 through the cut: floor at 895');
  assert.equal(limitPits(new Float32Array(0), 0, 0, 2), 0);
});

test('Runner: a deep DEM pit no longer fills metres deep; budget still closes', () => {
  const { w, h, z } = pitGrid(6);
  const run = (cap) => {
    const r = new Runner({ width: w, height: h, cellSizeM: 15, elevation: z, impervious: new Float32Array(w * h).fill(1), params: P, factor: 1 });
    if (!cap) r.core.z.set(Float64Array.from(z)); // the raw DEM, as before the cap
    let mx = 0;
    r.run([150, 150, 0, 0], P, (x) => { for (const v of x.frame) mx = Math.max(mx, v / 1000); });
    const b = r.core.budget;
    return { mx, closure: (b.rain - b.outflow - r.core.totalVolume()) / b.rain };
  };
  const capped = run(true), raw = run(false);
  assert.ok(raw.mx > 3, `raw pit fills deep (${raw.mx.toFixed(2)} m)`);
  assert.ok(capped.mx <= PIT_MAX_M + 0.35, `capped pit ${capped.mx.toFixed(2)} m`);
  assert.ok(Math.abs(capped.closure) < 1e-12, `closure ${capped.closure}`);
});

test('inflow edges: closed while the inflow runs high, reopened (as free outfalls) once it recedes', () => {
  // a plane tilting north (low side = north edge); outflow with the north edge closed, reopened, never closed
  const tilt = { width: 20, height: 20, cellSizeM: 30, elevation: Float32Array.from({ length: 400 }, (_, i) => 900 + Math.floor(i / 20) * 0.3), impervious: new Float32Array(400).fill(1) };
  const north = Int32Array.from({ length: 20 }, (_, c) => c);
  const outflow = (mode) => {
    const s = new SimCore(tilt, P);
    if (mode !== 'open') s.closeEdges(north);
    if (mode === 'reopened') s.setEdgesClosed(false);
    s.sources = { cells: Int32Array.of(2 * 20 + 10), m3s: Float64Array.of(2) };
    s.stepHour(0);
    const b = s.budget;
    assert.ok(Math.abs(b.inflow - b.outflow - s.totalVolume()) < 1e-9 * b.inflow, 'mass balance');
    return { out: b.outflow, closed: s.edgesClosed };
  };
  const closed = outflow('closed'), reopened = outflow('reopened'), open = outflow('open');
  assert.equal(closed.closed, true);
  assert.equal(reopened.closed, false);
  assert.ok(closed.out < 0.5 * open.out, `closed ${closed.out} vs open ${open.out}`);
  assert.ok(Math.abs(reopened.out - open.out) < 1e-9 * open.out, 'reopened = never closed');
  // closing twice keeps the original (open) slopes: reopening still restores them
  const s = new SimCore(tilt, P);
  s.closeEdges(north);
  s.closeEdges(north.subarray(0, 5));
  s.setEdgesClosed(false);
  s.sources = { cells: Int32Array.of(2 * 20 + 10), m3s: Float64Array.of(2) };
  s.stepHour(0);
  assert.ok(Math.abs(s.budget.outflow - open.out) < 1e-9 * open.out);

  // Runner: edges follow the inflow hydrograph (closed in the high hours only)
  const W = 40, H = 40;
  const elevation = Float32Array.from({ length: W * H }, (_, i) => 900 + Math.floor(i / W) * 0.2);
  const point = { cell: 6 * W + 20, at: [77.6, 12.9], areaKm2: 2, impervious: 1, drainShare: 1, timeArea: [1], storageH: 1 };
  const r = new Runner({ width: W, height: H, cellSizeM: 15, elevation, impervious: new Float32Array(W * H).fill(1), params: { drainCapacityMmHr: 0, infiltrationMmHr: 0, drainBlockage: 0 }, factor: 1, inflow: [point], inflowEdge: [[0, 10, 30]] });
  const states = [];
  r.run([40, 0, 0, 0, 0, 0, 0, 0], { drainCapacityMmHr: 0, infiltrationMmHr: 0, drainBlockage: 0 }, () => states.push(r.core.edgesClosed));
  assert.equal(states[0], true, 'closed while the inflow peaks');
  assert.equal(states[states.length - 1], false, 'reopened in the tail');
});

test('inflow edges extend across a tank the grid edge cuts (its cut and low banks), and the tank then holds the inflow', async () => {
  const { closeAcrossWater } = await import('../inflow.ts');
  // 30 x 30 at 40 m: ground rising east from 902 m; a flat tank at 900 m on rows 8-20, cols 0-5, cut by the
  // west edge; its banks along the edge at 900.5 / 901.5 m (rows 21-22), then 903 m
  const W = 30, H = 30, z = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) z[r * W + c] = 902 + 0.05 * c;
  for (let r = 8; r <= 20; r++) for (let c = 0; c <= 5; c++) z[r * W + c] = 900;
  z[21 * W] = 900.5;
  z[22 * W] = 901.5;
  for (let r = 23; r < H; r++) z[r * W] = 903;
  const west = (a, b) => Int32Array.from({ length: b - a + 1 }, (_, k) => (a + k) * W);
  const rows = (cells) => [...cells].filter((i) => i % W === 0).map((i) => i / W).sort((a, b) => a - b);
  // the closed run (rows 0-8) reaches the tank: the cut (8-20) and its banks (21-22) close, the 903 m ground does not
  const ext = closeAcrossWater(west(0, 8), W, H, 40, z);
  assert.deepEqual(rows(ext), Array.from({ length: 23 }, (_, k) => k));
  // a run ending next to the cut (row 7) still reaches it; one ending two cells short does not
  assert.equal(rows(closeAcrossWater(west(0, 7), W, H, 40, z)).length, 23);
  assert.deepEqual(rows(closeAcrossWater(west(0, 6), W, H, 40, z)), [0, 1, 2, 3, 4, 5, 6]);
  // a flat smaller than 1 ha is not a tank
  const small = Float32Array.from(z);
  for (let r = 8; r <= 20; r++) for (let c = 0; c <= 5; c++) small[r * W + c] = 902 + 0.05 * c + 0.001 * r * c;
  small[8 * W] = small[9 * W] = 900;
  assert.deepEqual(rows(closeAcrossWater(west(0, 8), W, H, 40, small)), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  // a mapped tank (lakeMask) on the south edge, touched by a closed south run, closes along its cut
  const lake = new Uint8Array(W * H);
  const zl = Float32Array.from(z);
  for (let r = 25; r < H; r++) for (let c = 10; c <= 14; c++) { lake[r * W + c] = 1; zl[r * W + c] = 898.5 + 0.1 * c; }
  const south = closeAcrossWater(Int32Array.from([29 * W + 8, 29 * W + 9]), W, H, 40, zl, lake);
  assert.deepEqual([...south].map((i) => i % W).sort((a, b) => a - b), [8, 9, 10, 11, 12, 13, 14]);
  assert.equal(closeAcrossWater([], W, H, 40, z).length, 0);

  // the tank holds the inflow while the edges are closed: little leaves across its cut, mass balance closes
  const g = { width: W, height: H, cellSizeM: 40, elevation: z, impervious: new Float32Array(W * H).fill(1) };
  const run = (cells) => {
    const s = new SimCore(g, P);
    s.closeEdges(cells);
    s.sources = { cells: Int32Array.of(14 * W + 3), m3s: Float64Array.of(5) };
    for (let k = 0; k < 3; k++) s.stepHour(0);
    const b = s.budget;
    assert.ok(Math.abs(b.inflow - b.outflow - s.totalVolume()) < 1e-12 * b.inflow, 'mass balance');
    return b.outflow / b.inflow;
  };
  const before = run(west(0, 8)), after = run(ext);
  assert.ok(before > 0.3, `open cut drains the inflow (${before.toFixed(2)})`);
  assert.ok(after < 0.05, `closed cut holds it (${after.toFixed(3)})`);
});
