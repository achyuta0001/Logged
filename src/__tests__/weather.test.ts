// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Run: node --test src/__tests__/weather.test.ts   (Node >= 22.6 strips TS types natively; no deps, no network)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HISTORICAL_EVENTS, HISTORICAL_PAD, archiveUrl, buildHistoricalSeries } from '../weather.ts';

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
