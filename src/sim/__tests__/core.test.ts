// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Run: node --test src/sim/__tests__/   (Node >= 22.6 strips TS types natively; no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimCore } from '../core.ts';
import { bowlAndChannel, noisyTerrain } from './synthetic.ts';

const noLoss = { drainCapacityMmHr: 0, infiltrationMmHr: 0, drainBlockage: 0 };

function closure(s: SimCore) {
  const b = s.budget;
  const stored = s.totalVolume();
  return { stored, err: Math.abs(b.rain - b.infiltrated - b.drained - b.lake - b.outflow - stored) / b.rain };
}

test('mass is conserved (no losses)', () => {
  const s = new SimCore(bowlAndChannel(), noLoss);
  for (const mm of [20, 50, 30, 0, 0, 0]) s.stepHour(mm);
  const { err } = closure(s);
  assert.ok(err < 1e-9, `relative budget error ${err}`);
});

test('mass is conserved with infiltration, drains, lakes', () => {
  const g = noisyTerrain(120, 140);
  const s = new SimCore(g, { drainCapacityMmHr: 20, infiltrationMmHr: 10, drainBlockage: 0.3 });
  for (const mm of [10, 40, 60, 20, 0, 0, 0, 0]) s.stepHour(mm);
  const { err } = closure(s);
  assert.ok(err < 1e-9, `relative budget error ${err}`);
  assert.ok(s.budget.infiltrated > 0 && s.budget.drained > 0 && s.budget.lake > 0 && s.budget.outflow > 0);
});

test('post-storm pond drainage is mass-conserving, off in heavy rain, and empties a closed bowl', () => {
  const g = bowlAndChannel(); // fully sealed: no infiltration path, only drains / edge outflow
  const p = { drainCapacityMmHr: 20, infiltrationMmHr: 0, drainBlockage: 0 };
  const s = new SimCore(g, p);
  const wet = s.stepHour(60); // 60 mm/h >> roadside capacity: the basin term must stay off
  // during heavy rain only the local inlet term (no mapped drains: 20 mm/h per cell) removes water
  assert.ok(wet.drainedM3 <= 0.02 * g.width * g.height * 15 * 15 * (1 + 1e-9), `drained in rain ${wet.drainedM3}`);
  const pondAfterRain = s.totalVolume();
  const dry = [];
  for (let k = 0; k < 8; k++) dry.push(s.stepHour(0));
  const { err } = closure(s);
  assert.ok(err < 1e-9, `relative budget error ${err}`);
  // per-hour stats close too: storage change = rain - losses
  let v = pondAfterRain;
  for (const h of dry) {
    const expect = v + h.rainM3 - h.infiltratedM3 - h.drainedM3 - h.lakeM3 - h.outflowM3;
    assert.ok(Math.abs(expect - h.volumeM3) < 1e-6 * pondAfterRain, `hour budget ${expect} vs ${h.volumeM3}`);
    v = h.volumeM3;
  }
  // the bowl (closed, ~1.5 m deep pond) drains through its catchment's free roadside capacity,
  // much faster than its own 20 mm/h local inlets alone would allow
  const centre = (g.height / 2) * g.width + g.width / 4;
  const localOnly = 1.5 - 8 * 0.02; // what 8 h of the 20 mm/h local inlets alone would leave at the centre
  assert.ok(s.h[centre] < 0.25 && s.h[centre] < localOnly / 4, `bowl centre still ${s.h[centre]} m after 8 dry hours`);
  // lagged onset: the same pond drains faster once the network has been idle for hours
  const fresh = new SimCore(g, p);
  fresh.stepHour(60);
  const idle = new SimCore(g, p);
  idle.stepHour(60);
  idle.h.set(fresh.h); // same pond...
  (idle as unknown as { drainIdleS: number }).drainIdleS = 1e9; // ...but drains long idle
  const a = fresh.stepHour(0).drainedM3, b = idle.stepHour(0).drainedM3;
  assert.ok(b > a * 1.05, `idle network should drain more in the first dry hour (${b} vs ${a})`);
});

test('lake freeboard grows with tank area', async () => {
  const { lakeFreeboardM } = await import('../core.ts');
  assert.ok(lakeFreeboardM(900) < lakeFreeboardM(1e4) && lakeFreeboardM(1e4) < lakeFreeboardM(3e5));
  assert.ok(lakeFreeboardM(1) >= 0.15 && lakeFreeboardM(1e9) <= 0.6);
});

test('bowl fills and forms a flat pond; channel drains', () => {
  const n = 120;
  const g = bowlAndChannel(n);
  const s = new SimCore(g, noLoss);
  s.stepHour(60);
  for (let k = 0; k < 6; k++) s.stepHour(0);
  const centre = (n / 2) * n + n / 4;
  const dCentre = s.h[centre];
  assert.ok(dCentre > 0.3, `bowl centre depth ${dCentre}`);
  // pond surface flat: compare water level at centre and 10 cells away (still inside pond)
  const off = centre + 8;
  const lvlA = s.z[centre] + s.h[centre], lvlB = s.z[off] + s.h[off];
  assert.ok(s.h[off] > 0 && Math.abs(lvlA - lvlB) < 0.02, `pond levels ${lvlA} vs ${lvlB}`);
  // channel half nearly empty
  let chanVol = 0;
  for (let r = 0; r < n; r++) for (let c = n / 2 + 2; c < n; c++) chanVol += s.h[r * n + c];
  const chanRain = 0.06 * n * (n / 2 - 2);
  assert.ok(chanVol < 0.05 * chanRain, `channel retained ${chanVol / chanRain}`);
  // channel concentrates flow mid-storm
  const s2 = new SimCore(g, noLoss);
  s2.stepHour(60);
  const mid = (n / 2) * n + Math.floor(0.8 * n);
  const side = (n / 2 + 20) * n + Math.floor(0.8 * n);
  assert.ok(s2.h[mid] > 3 * s2.h[side], `channel ${s2.h[mid]} vs slope ${s2.h[side]}`);
});

test('coarsen + downscale preserves volume; FloodEngine inline produces hourly snapshots', async () => {
  const { coarsen, downscaleMm } = await import('../grid.ts');
  const g = noisyTerrain(90, 110);
  const c = coarsen(g, 2);
  const s = new SimCore(c.grids, noLoss);
  s.stepHour(60);
  const frame = new Uint16Array(90 * 110);
  downscaleMm(c, s.h, g.elevation, frame);
  let fine = 0;
  for (const v of frame) fine += v / 1000;
  const fineVol = fine * 15 * 15;
  const coarseVol = s.totalVolume();
  // interior blocks are exact; mm rounding + partial edge blocks allow ~1%
  assert.ok(Math.abs(fineVol - coarseVol) / coarseVol < 0.01, `fine ${fineVol} vs coarse ${coarseVol}`);

  const { FloodEngine } = await import('../index.ts');
  const terrain = { meta: { width: 90, height: 110, cellSizeM: 15 }, grids: { elevation: g.elevation, impervious: g.impervious, drainMask: g.drainMask, lakeMask: g.lakeMask, boundaryMask: g.boundaryMask } };
  const eng = await FloodEngine.create(terrain, {}, { inline: true });
  const mm = [0, 30, 50, 0, 0];
  let calls = 0;
  await eng.run({ source: 'scenario', label: 't', times: mm.map((_, i) => i * 3.6e6), mm }, () => calls++);
  assert.equal(eng.hours, 5);
  assert.equal(calls, 5);
  const s2 = eng.snapshot(2), s4 = eng.snapshot(4);
  assert.ok(s2 && s4 && s2.totalVolumeM3 > 0);
  for (let i = 0; i < s4.depth.length; i++) assert.ok(s4.maxDepth[i] >= s4.depth[i] && s4.maxDepth[i] >= s2.depth[i]);
  assert.equal(eng.snapshot(99), undefined);
});
