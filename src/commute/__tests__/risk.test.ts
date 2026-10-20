// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Commute risk engine: rain series in, levels out (fixtures), plus the track arithmetic.
// Run: node --test src/commute/__tests__/risk.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hotspotOutlook, hotspotRisk, levelAt, levelOf, rainBetween, rainAt, riskWindow, scoreRisk, thresholdOf, trackFromSums, LEVEL_TEXT } from '../risk.ts';
import { BUCKET_MS, LEVEL_FROM, SCORE, THRESHOLD_SCALE, TYPE_THRESHOLD_MMHR } from '../config.ts';

const H = 3600e3;
const T0 = Date.UTC(2026, 9, 20, 0, 0); // 05:30 IST, on the bucket grid
const spot = (o = {}) => ({ id: 'x', type: 'junction', lowness: 0.5, reportDays: 3, ...o });
/** hourly sums stamped at the END of each hour, starting with the hour that ends at T0 + 1 h */
const hourly = (mm: number[], start = T0) => trackFromSums(mm.map((_, i) => start + (i + 1) * H), mm, H);

test('hourly sums stamped at the hour end fill the two half-hours before the stamp', () => {
  const tr = hourly([0, 6, 0]);
  assert.equal(tr.t0, T0);
  assert.equal(tr.stepMs, BUCKET_MS);
  assert.deepEqual(tr.mmHr, [0, 0, 6, 6, 0, 0]);
  assert.equal(rainAt(tr, T0 + H + 1), 6);
  assert.ok(Number.isNaN(rainAt(tr, T0 - 1)));
  assert.equal(rainBetween(tr, T0, T0 + 3 * H), 6);
  assert.equal(rainBetween(tr, T0 + H, T0 + 1.5 * H), 3);
});

test('15-minute sums are summed into 30-minute intensities', () => {
  const q = [1, 2, 0.5, 0.5];
  const tr = trackFromSums(q.map((_, i) => T0 + (i + 1) * 15 * 60e3), q, 15 * 60e3);
  assert.deepEqual(tr.mmHr, [6, 2]);
});

test('terms add up to the score, and dry weather is clear whatever the ground or history', () => {
  const x = scoreRisk({ rainNextMmHr: 7, rainLast1hMm: 4, rainLast24hMm: 25, thresholdMmHr: 7, lowness: 1, reportDays: 6 });
  const sum = Object.values(x.terms).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - x.score) < 0.01);
  assert.equal(x.terms.rain, 1);
  assert.equal(x.terms.recentRain, (SCORE.persist * 4) / 7 >= 0 ? Math.round(((SCORE.persist * 4) / 7) * 1000) / 1000 : 0);
  const dry = scoreRisk({ rainNextMmHr: 0, rainLast1hMm: 0, rainLast24hMm: 0, thresholdMmHr: 5, lowness: 1, reportDays: 20 });
  assert.equal(dry.score, 0);
  assert.equal(levelOf(dry), 'clear');
});

test('fixtures: rain series -> expected levels at a junction (threshold 7 mm/h, lowness 0.5, 3 report days)', () => {
  const h = spot();
  // type thresholds as configured, before the fitted global scale
  const at = (mm: number[], hour: number) => hotspotRisk(h, hourly(mm), T0 + hour * H, { scale: 1 }).level;
  // dry day
  assert.equal(at([0, 0, 0, 0], 2), 'clear');
  // drizzle, 0.3 mm/h: below the rain floor
  assert.equal(at([0.3, 0.3, 0.3, 0.3], 3), 'clear');
  // a light shower, 2 mm/h on a dry day: watch at most
  assert.ok(['clear', 'watch'].includes(at([0, 0, 2, 0], 2)));
  // moderate rain 5 mm/h after a wet morning
  assert.equal(at([6, 6, 5, 5], 3), 'likely');
  // heavy rain 12 mm/h
  assert.equal(at([2, 8, 12, 4], 2), 'severe');
  // just after a downpour stops, the last hour's water still counts
  assert.ok(['watch', 'likely'].includes(at([0, 0, 14, 0], 3)));
});

test('the fitted threshold scale applies by default and needs more rain for the same level', () => {
  const tr = hourly([6, 6, 5, 5]);
  const fitted = hotspotRisk(spot(), tr, T0 + 3 * H);
  const plain = hotspotRisk(spot(), tr, T0 + 3 * H, { scale: 1 });
  assert.ok(THRESHOLD_SCALE >= 1);
  assert.equal(fitted.explain.thresholdMmHr, Math.round(TYPE_THRESHOLD_MMHR.junction * THRESHOLD_SCALE * 1000) / 1000);
  assert.ok(fitted.explain.score <= plain.explain.score);
});

test('an underpass waterlogs at less rain than a layout', () => {
  const tr = hourly([0, 0, 4, 4]);
  const u = hotspotRisk(spot({ type: 'underpass' }), tr, T0 + 3 * H);
  const l = hotspotRisk(spot({ type: 'layout' }), tr, T0 + 3 * H);
  assert.ok(u.explain.score > l.explain.score);
  assert.equal(thresholdOf({ type: 'underpass' }, 1), TYPE_THRESHOLD_MMHR.underpass);
  assert.equal(thresholdOf({ type: 'road', thresholdMmHr: 3 }, 2), 6);
});

test('more lowness, history or antecedent rain never lowers the score', () => {
  const base = { rainNextMmHr: 4, rainLast1hMm: 2, rainLast24hMm: 10, thresholdMmHr: 7, lowness: 0.2, reportDays: 1 };
  const s0 = scoreRisk(base).score;
  assert.ok(scoreRisk({ ...base, lowness: 0.9 }).score > s0);
  assert.ok(scoreRisk({ ...base, reportDays: 8 }).score > s0);
  assert.ok(scoreRisk({ ...base, rainLast24hMm: 60 }).score > s0);
});

test('flood-model depth sets a floor under the level', () => {
  const dry = { rainNextMmHr: 0, rainLast1hMm: 0, rainLast24hMm: 0, thresholdMmHr: 7, lowness: 0, reportDays: 0 };
  assert.equal(levelOf(scoreRisk({ ...dry, modelDepthM: 0.08 })), 'watch');
  assert.equal(levelOf(scoreRisk({ ...dry, modelDepthM: 0.2 })), 'likely');
  assert.equal(levelOf(scoreRisk({ ...dry, modelDepthM: 0.4 })), 'severe');
  assert.equal(scoreRisk({ ...dry, modelDepthM: 0.4 }).modelDepthM, 0.4);
});

test('level bands follow config', () => {
  const mk = (score: number) => ({ rainNextMmHr: 5, rainLast1hMm: 0, rainLast24hMm: 0, thresholdMmHr: 5, lowness: 0, reportDays: 0, terms: {}, score });
  assert.equal(levelOf(mk(LEVEL_FROM.watch - 0.01)), 'clear');
  assert.equal(levelOf(mk(LEVEL_FROM.watch)), 'watch');
  assert.equal(levelOf(mk(LEVEL_FROM.likely)), 'likely');
  assert.equal(levelOf(mk(LEVEL_FROM.severe)), 'severe');
  assert.ok(!Object.values(LEVEL_TEXT).some((t) => /safe/i.test(t)));
});

test('outlook: 30-minute buckets over the horizon, and the likely-or-worse window', () => {
  // 1-h stamps: dry, dry, 10, 10, dry, dry (mm/h) from T0
  const tr = hourly([0, 0, 10, 10, 0, 0, 0, 0]);
  const o = hotspotOutlook(spot(), tr, { from: T0 + 10 * 60e3, scale: 1 });
  assert.equal(o.buckets.length, 6); // 3 h of 30 min
  assert.equal(o.buckets[0].t, T0);
  assert.deepEqual(o.window, [T0 + 2 * H, T0 + 2.5 * H]);
  assert.deepEqual(riskWindow(o.buckets), o.window);
  assert.equal(levelAt(o, T0 + 2 * H + 5 * 60e3), o.buckets[4].level);
  assert.equal(levelAt(o, T0 + 4 * H), null);
  // a longer horizon is clipped to the end of the rain
  const long = hotspotOutlook(spot(), tr, { from: T0, to: T0 + 48 * H });
  assert.equal(long.buckets.length, 16);
  // flood-model hook
  const d = hotspotOutlook(spot(), hourly([0, 0, 0, 0]), { from: T0, depthAt: (_id, t) => (t >= T0 + H ? 0.2 : 0) });
  assert.equal(d.buckets[0].level, 'clear');
  assert.equal(d.buckets[2].level, 'likely');
});
