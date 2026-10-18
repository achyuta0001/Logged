// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Storm-drain network (dual drainage): mass balance, surcharge at a constriction, no surcharge with ample capacity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimCore } from '../core.ts';
import { DrainNetwork } from '../network.ts';
import { noisyTerrain } from './synthetic.ts';

/** a straight drain along the middle row of a plane falling to the east edge (outlet at c = w - 1) */
function line(w = 40, h = 7, dx = 30) {
  const n = w * h;
  const z = new Float64Array(n);
  const drainMask = new Uint8Array(n);
  const mid = (h - 1) / 2;
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      z[r * w + c] = 100 - 0.01 * c * dx + 0.05 * Math.abs(r - mid) * dx;
      if (r === mid) drainMask[r * w + c] = 1;
    }
  return { w, h, dx, z, drainMask, lakeComp: new Int32Array(n).fill(-1), lakeRoom: new Float64Array(0), serveRadiusCells: 3, mid };
}

/** run the network alone: 1 m of water on the western half, captured at `capMmHr` for `hours` */
function drive(g, net, hours = 2, capMmHr = 200) {
  const n = g.w * g.h;
  const h = new Float64Array(n);
  for (let r = 0; r < g.h; r++) for (let c = 0; c < g.w / 2; c++) h[r * g.w + c] = 1;
  const start = h.reduce((a, b) => a + b, 0) * g.dx * g.dx;
  const rate = new Float64Array(n).fill(1);
  const dt = 60;
  const cap = (capMmHr / 1000 / 3600) * dt;
  const surcharged = new Float64Array(n);
  for (let s = 0; s < (hours * 3600) / dt; s++) {
    const before = h.slice();
    net.exchange(h, cap, rate, cap / dt, dt);
    for (let i = 0; i < n; i++) {
      // water appearing on a cell that was not draining: overflow from the network
      if (h[i] > before[i] + 1e-12) surcharged[i] += h[i] - before[i];
    }
  }
  const surface = h.reduce((a, b) => a + b, 0) * g.dx * g.dx;
  return { start, surface, surcharged };
}

test('drain network conserves mass: surface + network + outflow = start', () => {
  const g = line();
  const net = new DrainNetwork(g);
  const { start, surface } = drive(g, net);
  const t = net.totals;
  const err = Math.abs(start - surface - net.storage() - t.out - t.lake - t.sink) / start;
  assert.ok(err < 1e-12, `relative error ${err}`);
  assert.ok(t.inflow > 0 && t.out > 0, 'water entered and left the network');
});

test('a constriction surcharges upstream of it, not downstream', () => {
  const g = line();
  const net = new DrainNetwork(g);
  const node = (c) => Array.from(net.cell).indexOf(g.mid * g.w + c);
  const kc = node(25); // constricted reach leaving column 25
  for (let k = 0; k < net.size; k++) net.designArea[k] *= 20; // ample everywhere ...
  net.designArea[kc] = net.designArea[kc] / 400; // ... except one reach
  const { surcharged } = drive(g, net);
  assert.ok(net.totals.surcharge > 0, 'the constriction overflows');
  let up = 0, downstream = 0;
  for (let c = 0; c < g.w; c++) {
    const v = surcharged[g.mid * g.w + c];
    if (c <= 25) up += v;
    else downstream += v;
  }
  assert.ok(up > 0, 'overflow at or above the constriction');
  assert.equal(downstream, 0, 'nothing overflows below it');
});

test('ample drain capacity: no surcharge', () => {
  const g = line();
  const net = new DrainNetwork(g);
  for (let k = 0; k < net.size; k++) net.designArea[k] *= 50;
  drive(g, net);
  assert.equal(net.totals.surcharge, 0);
  assert.ok(net.totals.out > 0);
});

test('SimCore with the drain network: whole budget closes and hour stats report it', () => {
  const g = noisyTerrain(120, 140);
  const s = new SimCore(g, { drainCapacityMmHr: 30, infiltrationMmHr: 5, drainBlockage: 0.2 });
  assert.ok(s.net && s.net.size > 0, 'network built from drainMask');
  const hours = [];
  for (const mm of [10, 60, 80, 30, 0, 0, 0, 0]) hours.push(s.stepHour(mm));
  const b = s.budget, t = s.net.totals;
  const source = b.rain + (b.inflow ?? 0);
  // surface view: drained is the net surface -> drains transfer
  const surf = Math.abs(source - b.infiltrated - b.drained - b.lake - b.outflow - s.totalVolume()) / source;
  assert.ok(surf < 1e-9, `surface budget error ${surf}`);
  // whole system: what the drains took is in the network, gone across the edge / into tanks, or a sink
  const sys = Math.abs(b.drained - s.net.storage() - t.out - t.lake - t.sink) / source;
  assert.ok(sys < 1e-9, `network budget error ${sys}`);
  const sum = (k) => hours.reduce((a, h) => a + h[k], 0);
  assert.ok(sum('networkOutM3') > 0, 'network discharges');
  assert.ok(Math.abs(sum('surchargeM3') - t.surcharge) < 1e-6 * source);
  assert.ok(Math.abs(hours.at(-1).networkM3 - s.net.storage()) < 1e-9 * source);
});
