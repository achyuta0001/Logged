// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Commute planner on synthetic routes: which hotspots a route meets and when, and the advice.
// Run: node --test src/commute/__tests__/plan.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCommute, routeHits, routeRisk } from '../plan.ts';
import { BUCKET_MS, PLAN } from '../config.ts';

const MIN = 60e3, H = 3600e3;
const T0 = Date.UTC(2026, 9, 20, 11, 30); // 17:00 IST, on the bucket grid
const LAT = 12.95;
const KX = 111320 * Math.cos((LAT * Math.PI) / 180);
/** a point x metres east of 77.6 E */
const east = (x: number, dy = 0) => [77.6 + x / KX, LAT + dy / 110574];

/** a straight eastward route of `km`, at `kmh` */
function route(id: string, km: number, kmh = 30, dy = 0, via = '') {
  const n = 11;
  const line = Array.from({ length: n }, (_, i) => east((km * 1000 * i) / (n - 1), dy));
  const cumS = line.map((_, i) => ((km * 1000 * i) / (n - 1) / (kmh * 1000)) * 3600);
  return { id, line, lengthM: km * 1000, durationS: cumS[n - 1], cumS, via };
}

/** an outlook with `level` in the buckets from a to b (ms), clear elsewhere, over 8 h from T0 - 2 h */
function outlook(id: string, wet: [number, number][] = [], level = 'likely') {
  const buckets = [];
  for (let t = T0 - 2 * H; t < T0 + 6 * H; t += BUCKET_MS) {
    const hit = wet.some(([a, b]) => t >= a && t < b);
    buckets.push({ id, t, level: hit ? level : 'clear', explain: { rainNextMmHr: 0, rainLast1hMm: 0, rainLast24hMm: 0, thresholdMmHr: 7, lowness: 0, reportDays: 0, terms: {}, score: 0 } });
  }
  const wetB = buckets.filter((b) => b.level !== 'clear');
  return { id, buckets, window: wetB.length ? [wetB[0].t, wetB[wetB.length - 1].t] : null };
}

const hs = [
  { id: 'mid', name: 'Mid Underpass', coord: east(5000, 40) },
  { id: 'far', name: 'Far Junction', coord: east(5000, 2000) },
];

test('route hits: within the buffer only, reached at the interpolated time and distance', () => {
  const r = route('A', 10);
  const hits = routeHits(r, hs);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'mid');
  assert.ok(Math.abs(hits[0].distanceM - 5000) <= 2);
  assert.ok(Math.abs(hits[0].atS - 600) <= 1); // 5 km at 30 km/h
  assert.ok(Math.abs(hits[0].offM - 40) <= 2);
  assert.equal(routeHits(r, hs, 30).length, 0);
  assert.equal(PLAN.bufferM, 150);
});

test('route level is the level of the bucket when the hotspot is reached', () => {
  const r = route('A', 10);
  const hits = routeHits(r, hs);
  const o = new Map([['mid', outlook('mid', [[T0 + 30 * MIN, T0 + 60 * MIN]])]]);
  assert.equal(routeRisk(r, hits, o, T0).level, 'clear'); // reached 17:10, wet from 17:30
  assert.equal(routeRisk(r, hits, o, T0 + 25 * MIN).level, 'likely'); // reached 17:35
});

test('go when route A is clear', () => {
  const p = planCommute([route('A', 10)], hs, [outlook('mid')], T0, T0 - H);
  assert.equal(p.advice.kind, 'go');
  assert.match(p.advice.text, /Advisory only/);
  assert.doesNotMatch(p.advice.text, /safe/i);
  assert.equal(p.routes[0].level, 'clear');
});

test('go, but watch', () => {
  const p = planCommute([route('A', 10)], hs, [outlook('mid', [[T0, T0 + H]], 'watch')], T0, T0 - H);
  assert.equal(p.advice.kind, 'go');
  assert.match(p.advice.text, /watch Mid Underpass/);
  assert.deepEqual(p.drivers, ['mid']);
});

test('leave by: the latest earlier departure that misses the water, less the margin', () => {
  // wet 17:30-19:30: leaving 17:00 reaches the underpass 17:10 (fine); asked for 17:30
  const p = planCommute([route('A', 10)], hs, [outlook('mid', [[T0 + 30 * MIN, T0 + 150 * MIN]])], T0 + 30 * MIN, T0 - H);
  assert.equal(p.advice.kind, 'leave_by');
  // last departure reaching it before 17:30 is 17:15 (arrives 17:25); minus 15 min margin = 17:00
  assert.equal(p.advice.at, T0);
  assert.match(p.advice.text, /^Leave by 17:00/);
  assert.deepEqual(p.drivers, ['mid']);
});

test('leave after: when an earlier start is not possible (now) and the water clears soon', () => {
  // wet 17:00-18:00; asked for 17:00, now is 17:00
  const p = planCommute([route('A', 10)], hs, [outlook('mid', [[T0, T0 + H]])], T0, T0);
  assert.equal(p.advice.kind, 'leave_after');
  // first departure reaching it at 18:00 or later is 17:50; plus the margin = 18:05
  assert.equal(p.advice.at, T0 + 65 * MIN);
  assert.match(p.advice.text, /^Leave after 18:05/);
});

test('use another route when it is clear at the same time and costs less than waiting', () => {
  const A = route('A', 10), B = route('B', 11, 30, 1000, 'via the north road');
  const p = planCommute([A, B], hs, [outlook('mid', [[T0, T0 + 3 * H]])], T0, T0);
  assert.equal(p.advice.kind, 'use_route');
  assert.equal(p.advice.route, 'B');
  assert.match(p.advice.text, /^Take route B via the north road/);
  assert.equal(p.routes.length, 2);
  assert.equal(p.routes[1].level, 'clear');
});

test('work from home when every route is likely waterlogged across the whole range', () => {
  const A = route('A', 10), B = route('B', 11, 30, 30);
  const p = planCommute([A, B], hs, [outlook('mid', [[T0 - 2 * H, T0 + 6 * H]], 'severe')], T0, T0);
  assert.equal(p.advice.kind, 'wfh');
  assert.match(p.advice.text, /working from home/);
  assert.deepEqual(p.drivers, ['mid']);
});

test('no forecast for the time: says so instead of a level', () => {
  const p = planCommute([route('A', 10)], hs, [outlook('mid')], T0 + 7 * H, T0);
  assert.equal(p.advice.kind, 'go');
  assert.match(p.advice.text, /No rain forecast covers/);
});
