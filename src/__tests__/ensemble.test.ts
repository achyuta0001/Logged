// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Run: node --test src/__tests__/ensemble.test.ts   (no deps, no network, no worker)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateEnsemble, areaRangeText, ensembleStatusText, outlookPeak, rangeText } from '../ensemble.ts';
import { fakeForecastVariants, variantsFromHourly } from '../weather.ts';

/** a model's result; only what a test cares about needs giving */
const member = (o) => ({ model: 'm', name: 'M', rainMm: 0, area: [0, 0, 0], peakHour: 0, floodedKm2: 0, twoWheelerKm: 0, carKm: 0, buildingsWet: 0, severity: 'none', ...o });

test('outlookPeak: largest value inside the window, first one on a tie, clamped to the series', () => {
  const a = [9, 1, 5, 7, 7, 2, 40];
  assert.equal(outlookPeak(a, 1, 4), 3); // hours 1..4: 7 at 3 and 4 -> the first
  assert.equal(outlookPeak(a, 0, 48), 6);
  assert.equal(outlookPeak(a, 2, 2), 3);
  assert.equal(outlookPeak([0, 0, 0], 1, 48), 1); // all dry: the window start
  assert.equal(outlookPeak(a, 99, 48), 6); // start past the end: the last hour
});

test('aggregate: min and max of every KPI across the models', () => {
  const s = aggregateEnsemble(
    [
      member({ model: 'a', floodedKm2: 0.1, twoWheelerKm: 1.2, carKm: 0.3, buildingsWet: 40, severity: 'moderate' }),
      member({ model: 'b', floodedKm2: 0.42, twoWheelerKm: 3.5, carKm: 1.1, buildingsWet: 210, severity: 'high' }),
      member({ model: 'c', floodedKm2: 0.05, twoWheelerKm: 0.4, carKm: 0, buildingsWet: 3, severity: 'low' }),
    ],
    'moderate',
  );
  assert.equal(s.n, 3);
  assert.equal(s.dry, false);
  assert.deepEqual(s.floodedKm2, { min: 0.05, max: 0.42 });
  assert.deepEqual(s.twoWheelerKm, { min: 0.4, max: 3.5 });
  assert.deepEqual(s.carKm, { min: 0, max: 1.1 });
  assert.deepEqual(s.buildingsWet, { min: 3, max: 210 });
  assert.equal(s.members.length, 3);
});

test('aggregate: the timeline band is the hourly min and max flooded area; a short series counts as dry after its end', () => {
  const s = aggregateEnsemble([member({ area: [0, 500, 900, 100] }), member({ area: [10, 200, 1500] }), member({ area: [0, 800, 1200, 50] })], 'none');
  assert.deepEqual(s.band.lo, [0, 200, 900, 0]);
  assert.deepEqual(s.band.hi, [10, 800, 1500, 100]);
});

test('aggregate: "worse" names the most severe model only when it beats the baseline; ties go to the larger area', () => {
  const ms = [
    member({ model: 'best_match', name: 'Best', severity: 'moderate', floodedKm2: 0.2 }),
    member({ model: 'gfs', name: 'GFS', severity: 'severe', floodedKm2: 0.6 }),
    member({ model: 'icon', name: 'ICON', severity: 'severe', floodedKm2: 0.9 }),
  ];
  assert.deepEqual(aggregateEnsemble(ms, 'moderate').worse, { model: 'icon', name: 'ICON', severity: 'severe' });
  assert.equal(aggregateEnsemble(ms, 'severe').worse, null); // nothing is worse than what is on screen
  assert.equal(aggregateEnsemble(ms.slice(0, 1).concat(member({ severity: 'low' })), 'moderate').worse, null);
});

test('aggregate: dry only when every model is dry; fewer than two models give no range', () => {
  assert.equal(aggregateEnsemble([member({}), member({ floodedKm2: 0.0004 })], 'none').dry, true);
  assert.equal(aggregateEnsemble([member({}), member({ severity: 'low', floodedKm2: 0.03 })], 'none').dry, false);
  assert.equal(aggregateEnsemble([member({ severity: 'high' })], 'none'), null);
  assert.equal(aggregateEnsemble([], 'none'), null);
});

test('range text: en dash between ends, one value when both read the same, zero as 0', () => {
  const f = (v) => v.toFixed(1);
  assert.equal(rangeText({ min: 0.4, max: 3.5 }, f), '0.4–3.5');
  assert.equal(rangeText({ min: 2.04, max: 1.96 + 0.04 }, f), '2.0');
  assert.equal(rangeText({ min: 0, max: 1.2 }, f), '0–1.2');
  assert.equal(rangeText({ min: 0.02, max: 1.2 }, f), '0–1.2'); // rounds to zero
  assert.equal(rangeText({ min: 0, max: 0 }, f), '0');
  assert.equal(areaRangeText({ min: 0.1, max: 0.42 }), '0.10–0.42 km²');
  assert.equal(areaRangeText({ min: 0, max: 0.012 }), '0–0.01 km²');
  assert.equal(areaRangeText({ min: 0.0002, max: 0.004 }), '0–0.4 ha');
  assert.equal(areaRangeText({ min: 0, max: 0.0006 }), '0–600 m²');
});

test('status text: the flooded-area range and the model count; nothing when every model is dry', () => {
  const wet = aggregateEnsemble([member({ floodedKm2: 0.1, severity: 'moderate' }), member({ floodedKm2: 0.42, severity: 'high' }), member({}), member({ floodedKm2: 0.2, severity: 'low' })], 'moderate');
  assert.equal(ensembleStatusText(wet), 'Flooded area 0–0.42 km² across 4 weather models');
  assert.equal(ensembleStatusText(aggregateEnsemble([member({}), member({})], 'none')), '');
  assert.equal(ensembleStatusText(null), '');
});

test('forecast members: one series per model, best match first, gaps filled from the best estimate', () => {
  const t0 = 1760000000;
  const hourly = {
    time: [0, 1, 2, 3].map((i) => t0 + i * 3600),
    precipitation_gfs_seamless: [1, null, 3, 0],
    precipitation_best_match: [0, 2, null, 1],
    precipitation_icon_seamless: [null, null, null, null], // returned nothing: not a member
  };
  const v = variantsFromHourly(hourly, 0, (t0 + 2 * 3600) * 1000);
  assert.deepEqual(v.models, ['best_match', 'gfs_seamless']);
  assert.deepEqual(v.best.mm, [0, 2, 3, 1]); // best match, its gap filled from the hourly max
  assert.deepEqual(
    v.members.map((m) => [m.model, m.name, m.series.mm]),
    [
      ['best_match', 'Open-Meteo best match', [0, 2, 3, 1]],
      ['gfs_seamless', 'NOAA GFS', [1, 2, 3, 0]],
    ],
  );
  assert.ok(v.members.every((m) => m.series.source === 'forecast' && m.series.nowIndex === 2 && m.series.times.length === 4));
});

test('dev fake forecast: four wet models that disagree on the amount, the storm ahead of now', () => {
  const now = Date.UTC(2026, 9, 18, 6, 30);
  const v = fakeForecastVariants(now);
  assert.equal(v.members.length, 4);
  const i0 = v.best.nowIndex;
  const ahead = v.members.map((m) => m.series.mm.slice(i0, i0 + 48).reduce((a, b) => a + b, 0));
  assert.ok(ahead.every((x) => x > 5));
  assert.ok(Math.max(...ahead) > 2 * Math.min(...ahead) + 50);
  assert.equal(v.members[0].series.mm.slice(0, i0 + 1).some((x) => x > 0), false);
});
