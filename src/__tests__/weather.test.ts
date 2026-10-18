// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Run: node --test src/__tests__/weather.test.ts   (Node >= 22.6 strips TS types natively; no deps, no network)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAUGE_SUFFIX, HISTORICAL_EVENTS, HISTORICAL_PAD, archiveUrl, buildHistoricalSeries, scaleToTotal } from '../weather.ts';

const H = 3600;
const EV = { id: 'test', label: 'Real storm: test', start: '2022-09-04', end: '2022-09-04', description: '', source: 'https://example.org' };
/** archive-shaped hourly block starting at t0 (unix seconds) */
const hourly = (mm, t0 = 1662229800) => ({ time: mm.map((_, i) => t0 + i * H), precipitation: mm });

test('series: trimmed to the wet window, dry hours padded before and after', () => {
  const s = buildHistoricalSeries(EV, hourly([0, 0, 0, 0, 0, 0, 2, 10.04, 0, 5, 0.05, 0, 0]), { before: 2, after: 4 });
  // wet window = index 6..9; keeps 2 dry hours ahead (4, 5); drops the < 0.1 mm tail; adds 4 dry hours
  assert.deepEqual(s.mm, [0, 0, 2, 10, 0, 5, 0, 0, 0, 0]);
  assert.equal(s.times[0], (1662229800 + 4 * H) * 1000);
  s.times.forEach((t, i) => i && assert.equal(t - s.times[i - 1], H * 1000));
  assert.equal(s.times.length, s.mm.length);
  assert.equal(s.source, 'scenario');
  assert.match(s.label, /^Real storm: test: 17 mm/);
});

test('series: an archive that starts wet gets dry hours prepended before its first hour', () => {
  const s = buildHistoricalSeries(EV, hourly([4, 1, 0]), { before: 3, after: 2 });
  assert.deepEqual(s.mm, [0, 0, 0, 4, 1, 0, 0]);
  assert.equal(s.times[3], 1662229800 * 1000);
  assert.equal(s.times[0], (1662229800 - 3 * H) * 1000);
});

test('series: missing hours are dry; an all-dry archive keeps the whole range', () => {
  const s = buildHistoricalSeries(EV, hourly([null, 0.4, null, 0.2]), { before: 0, after: 1 });
  assert.deepEqual(s.mm, [0.4, 0, 0.2, 0]);
  const dry = buildHistoricalSeries(EV, hourly([0, null, 0]), { before: 1, after: 2 });
  assert.deepEqual(dry.mm, [0, 0, 0, 0, 0, 0]); // 1 padded + 3 archive + 2 padded
  assert.equal(dry.times[1], 1662229800 * 1000);
});

test('series: default padding and bad input', () => {
  const s = buildHistoricalSeries(EV, hourly([0, 0, 0, 0, 0, 7, 0]));
  assert.equal(s.mm.length, HISTORICAL_PAD.before + 1 + HISTORICAL_PAD.after);
  assert.throws(() => buildHistoricalSeries(EV, { time: [1, 2], precipitation: [1] }), /no hourly precipitation/);
  assert.throws(() => buildHistoricalSeries(EV, { time: [], precipitation: [] }), /no hourly precipitation/);
});

const tenths = (mm) => Math.round(mm.reduce((a, b) => a + b, 0) * 10);

test('scaleToTotal: same shape, 0.1 mm steps, sums to the target exactly', () => {
  const mm = [0, 0.3, 2, 10, 0, 5.1, 0.1, 0];
  const out = scaleToTotal(mm, 131);
  assert.equal(out.length, mm.length);
  assert.equal(tenths(out), 1310);
  const k = 131 / mm.reduce((a, b) => a + b, 0);
  out.forEach((v, i) => {
    assert.ok(Math.abs(v - mm[i] * k) <= 0.1 + 1e-9, `hour ${i}: ${v} vs ${mm[i] * k}`);
    assert.equal(Math.round(v * 10), v * 10, `hour ${i} is a whole tenth`);
    if (mm[i] === 0) assert.equal(v, 0, 'dry hours stay dry');
  });
  assert.equal(out.indexOf(Math.max(...out)), 3, 'the wettest hour stays the wettest');
  // odd targets and a single wet hour
  assert.equal(tenths(scaleToTotal([1, 1, 1], 114)), 1140);
  assert.equal(tenths(scaleToTotal([0.1, 0.2, 0.4], 177.6)), 1776);
  assert.deepEqual(scaleToTotal([0, 7, 0], 144), [0, 144, 0]);
});

test('scaleToTotal: a dry series stays dry, scaling down works', () => {
  assert.deepEqual(scaleToTotal([0, 0, 0], 131), [0, 0, 0]);
  assert.deepEqual(scaleToTotal([], 131), []);
  assert.equal(tenths(scaleToTotal([10, 20, 30], 6)), 60);
  assert.deepEqual(scaleToTotal([10, 20, 30], 6), [1, 2, 3]);
});

test('series: a scaled event keeps the archive timing and totals the gauge reading', () => {
  const ev = { ...EV, id: 'test-gauge', label: 'Real storm: test · scaled to 131 mm gauge', gaugeMm: 131, gauge: 'IMD test', scaled: true };
  const h = hourly([0, 0, 0, 0, 0, 0, 2, 10.04, 0, 5, 0.05, 0, 0]);
  const raw = buildHistoricalSeries({ ...EV, gaugeMm: 131, gauge: 'IMD test' }, h, { before: 2, after: 4 });
  const s = buildHistoricalSeries(ev, h, { before: 2, after: 4 });
  assert.deepEqual(s.times, raw.times);
  assert.equal(tenths(s.mm), 1310);
  s.mm.forEach((v, i) => assert.equal(v > 0, raw.mm[i] > 0, `hour ${i} wet in both or dry in both`));
  assert.equal(s.mm.indexOf(Math.max(...s.mm)), raw.mm.indexOf(Math.max(...raw.mm)));
  assert.match(s.label, /scaled to 131 mm gauge \(archive 17\.0 mm x 7\.71\)$/);
  // nothing to scale: stays dry, says so
  const dry = buildHistoricalSeries(ev, hourly([0, 0, 0]), { before: 0, after: 1 });
  assert.equal(tenths(dry.mm), 0);
  assert.match(dry.label, /nothing to scale/);
});

test('events: every real storm has a gauge-scaled twin with the same request and source', () => {
  const raw = HISTORICAL_EVENTS.filter((e) => !e.scaled);
  const scaled = HISTORICAL_EVENTS.filter((e) => e.scaled);
  assert.equal(scaled.length, raw.length);
  for (const e of raw) {
    assert.ok(e.gaugeMm > 0 && e.gaugeMm < 400, `${e.id}: gauge total`);
    assert.ok(e.gauge.length > 2, `${e.id}: gauge named`);
    assert.ok(e.description.includes(`${e.gaugeMm} mm`), `${e.id}: the description quotes the gauge total`);
    const t = HISTORICAL_EVENTS.find((x) => x.id === e.id + GAUGE_SUFFIX);
    assert.ok(t?.scaled, `${e.id}: scaled twin`);
    for (const k of ['start', 'end', 'source', 'gaugeMm', 'gauge']) assert.equal(t[k], e[k], `${t.id}.${k}`);
    assert.equal(archiveUrl(12.9, 77.5, t), archiveUrl(12.9, 77.5, e));
    assert.equal(t.label, `${e.label} · scaled to ${e.gaugeMm} mm gauge`);
    assert.ok(t.description.includes(`${e.gaugeMm} mm`) && /our adjustment, not observed hourly rain/.test(t.description), t.id);
    assert.ok(!/our adjustment/.test(e.description), `${e.id}: raw archive entry is not described as adjusted`);
  }
});

test('events: sourced, dated, unique, and the archive request is well formed', () => {
  assert.ok(HISTORICAL_EVENTS.length >= 3);
  assert.equal(new Set(HISTORICAL_EVENTS.map((e) => e.id)).size, HISTORICAL_EVENTS.length);
  for (const e of HISTORICAL_EVENTS) {
    assert.match(e.label, /^Real storm: /);
    assert.match(e.start, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(e.end, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Date.parse(e.start) <= Date.parse(e.end), e.id);
    assert.ok(Date.parse(e.end) - Date.parse(e.start) <= 4 * 86400e3, `${e.id}: keep events short`);
    assert.match(e.source, /^https:\/\//);
    assert.ok(e.description.includes(e.source), `${e.id}: description cites its source`);
    const u = new URL(archiveUrl(12.9, 77.5, e));
    assert.equal(u.host, 'archive-api.open-meteo.com');
    assert.equal(u.searchParams.get('start_date'), e.start);
    assert.equal(u.searchParams.get('end_date'), e.end);
    assert.equal(u.searchParams.get('hourly'), 'precipitation');
    assert.equal(u.searchParams.get('timezone'), 'Asia/Kolkata');
    assert.equal(u.searchParams.get('timeformat'), 'unixtime');
  }
});
