// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Commute check and news-spot pipeline logic: pure functions, no network.
// Run: node --test src/commute/__tests__/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptHit, dedupeSpots, eventCount, extractMentions, isSpecific, kindOf, nameSimilar, normName, summarize, type GeoMention, type NewsSpot } from '../spots.ts';
import { pointInGeometry, reportsByArea, spotsNearRoute } from '../near.ts';
import {
  commuteSearch,
  hourIndex,
  nextCommute,
  nextWeekdayAt,
  parseCommuteLink,
  rainAround,
  rainSpell,
  spotVerdict,
  suggestion,
  tripVerdict,
} from '../verdict.ts';

const H = 3600e3;
/** ms epoch of an IST wall-clock time */
const ist = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - 5.5 * H;

const spot = (name: string, coord: [number, number], count = 1, kind: NewsSpot['kind'] = 'junction'): NewsSpot => ({
  id: name,
  name,
  coord,
  kind,
  reports: [{ date: '2022-09-05', url: `https://example.org/${encodeURIComponent(name)}`, outlet: 'example.org', summary: 's' }],
  count,
  firstYear: 2022,
  lastYear: 2022,
});

// ------------------------------------------------------------------ names and specificity
test('normName expands abbreviations and drops the city name', () => {
  assert.equal(normName('Silk Board Jn.'), 'silk board junction');
  assert.equal(normName('H.S.R. Layout, Bengaluru'), 'hsr layout');
  assert.equal(normName('Mehkri Circle'), 'mekhri circle');
});

test('kindOf reads the type word', () => {
  assert.equal(kindOf('Okalipuram underpass'), 'underpass');
  assert.equal(kindOf('Silk Board junction'), 'junction');
  assert.equal(kindOf('KR Circle'), 'junction');
  assert.equal(kindOf('Koramangala 80 Feet Road'), 'road');
  assert.equal(kindOf('HSR Layout'), 'layout');
  assert.equal(kindOf('Hebbal flyover'), 'other');
  assert.equal(kindOf('Koramangala'), null);
});

test('isSpecific keeps named places and drops generic phrases and city corridors', () => {
  for (const n of ['Silk Board Junction', 'KR Circle', 'Okalipuram Underpass', 'Queens Road', 'HSR Layout']) assert.ok(isSpecific(n), n);
  for (const n of ['Main Road', 'the underpass', '5th Cross', 'Outer Ring Road', 'Hosur Road', 'Service Road', 'Koramangala']) assert.ok(!isSpecific(n), n);
});

test('nameSimilar matches spellings of one place, not neighbours', () => {
  assert.ok(nameSimilar('Silk Board Junction', 'Central Silk Board junction'));
  assert.ok(nameSimilar('Sony World Signal', 'Sony World Junction'));
  assert.ok(!nameSimilar('Hebbal Flyover', 'Mekhri Circle'));
});

// ------------------------------------------------------------------ mentions
test('extractMentions finds places only in flood sentences, any case of the type word', () => {
  const text =
    'Police said the KR Circle underpass and the Okalipuram underpass were flooded after heavy rain. ' +
    'A tree fell on Jayanagar 7th Block Road in the evening. Waterlogging at Silk Board junction slowed traffic.';
  const got = extractMentions(text).map((m) => `${m.phrase}|${m.kind}`);
  assert.deepEqual(got, ['KR Circle underpass|underpass', 'Okalipuram underpass|underpass', 'Silk Board junction|junction']);
});

test('summarize writes at most 15 own words', () => {
  const s = summarize('Silk Board Junction', 'junction', 'waterlogging', 'Heavy rain left Silk Board junction waterlogged and vehicles stranded for hours.');
  assert.equal(s, 'Waterlogging reported at Silk Board Junction after heavy rain; traffic slowed or stranded.');
  assert.ok(s.split(/\s+/).length <= 15);
});

// ------------------------------------------------------------------ geocode filtering
test('acceptHit: inside the district, one place, short roads only', () => {
  assert.ok(acceptHit('Silk Board Junction', { coord: [77.6237, 12.9177] }));
  assert.ok(!acceptHit('Silk Board Junction', { coord: [80.27, 13.08] }), 'Chennai is outside Bengaluru Urban');
  assert.ok(!acceptHit('Dairy Circle', { coord: [77.6017, 12.937], spreadM: 18000 }), 'a name used in two far-apart places');
  assert.ok(acceptHit('Queens Road', { coord: [77.597, 12.983], lengthM: 1500 }));
  assert.ok(!acceptHit('Sankey Road', { coord: [77.58, 13.0], lengthM: 7027 }), 'a 7 km road is not a spot');
  assert.ok(!acceptHit('Queens Road', { coord: [77.597, 12.983] }), 'a road without a known length');
  assert.ok(!acceptHit('Silk Board Junction', null));
});

// ------------------------------------------------------------------ dedupe and counting
test('eventCount merges dates within two days', () => {
  assert.equal(eventCount(['2022-09-05', '2022-09-06', '2022-09-05', '2023-05-21', '2024-10-21']), 3);
  assert.equal(eventCount([]), 0);
});

test('dedupeSpots merges nearby similar names, keeps different places apart', () => {
  const r = (date: string, url: string) => ({ date, url, outlet: 'x', summary: 's' });
  const ms: GeoMention[] = [
    { name: 'Silk Board Junction', kind: 'junction', coord: [77.6237, 12.9177], report: r('2022-09-05', 'a') },
    { name: 'Silk Board Junction', kind: 'junction', coord: [77.6239, 12.9178], report: r('2022-09-06', 'b') },
    { name: 'Central Silk Board Junction', kind: 'junction', coord: [77.6232, 12.9172], report: r('2024-08-12', 'c') },
    { name: 'Silk Board Junction', kind: 'junction', coord: [77.6237, 12.9177], report: r('2022-09-05', 'a') },
    { name: 'BTM Layout', kind: 'layout', coord: [77.6243, 12.9181], report: r('2024-08-12', 'd') }, // 100 m away, other name
    { name: 'Hebbal Flyover', kind: 'other', coord: [77.5903, 13.0424], report: r('2023-06-20', 'e') },
  ];
  const spots = dedupeSpots(ms, 150);
  assert.equal(spots.length, 3);
  const sb = spots.find((s) => s.name === 'Silk Board Junction')!;
  assert.equal(sb.reports.length, 3, 'unique by url');
  assert.equal(sb.count, 2, '5 and 6 Sep 2022 are one flood');
  assert.equal(sb.firstYear, 2022);
  assert.equal(sb.lastYear, 2024);
});

// ------------------------------------------------------------------ route proximity and areas
test('spotsNearRoute keeps spots within 100 m, in travel order', () => {
  // a route going east along lat 12.92, then north
  const route: [number, number][] = [
    [77.6, 12.92],
    [77.61, 12.92],
    [77.61, 12.93],
  ];
  const spots = [
    spot('far', [77.605, 12.925]), // ~550 m north of the first leg
    spot('second', [77.6108, 12.928]), // ~87 m east of the second leg
    spot('first', [77.603, 12.9205]), // ~55 m north of the first leg
  ];
  const near = spotsNearRoute(route, spots, 100);
  assert.deepEqual(near.map((n) => n.spot.name), ['first', 'second']);
  assert.ok(near[0].distM > 40 && near[0].distM < 70, `${near[0].distM}`);
  assert.ok(near[1].alongM > near[0].alongM);
  assert.deepEqual(spotsNearRoute([[77.6, 12.92]], spots), []);
});

test('pointInGeometry and reportsByArea count spots per pincode', () => {
  const sq: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[77.6, 12.9], [77.7, 12.9], [77.7, 13.0], [77.6, 13.0], [77.6, 12.9]]] };
  assert.ok(pointInGeometry([77.65, 12.95], sq));
  assert.ok(!pointInGeometry([77.75, 12.95], sq));
  const by = reportsByArea([{ key: '560034', geometry: sq }], [spot('a', [77.65, 12.95], 4), spot('b', [77.61, 12.91], 2), spot('c', [77.8, 12.95], 9)]);
  assert.deepEqual(by.get('560034'), { spots: 2, reports: 6 });
});

// ------------------------------------------------------------------ departure time and rain
test('nextWeekdayAt skips weekends; nextCommute picks the next of 09:00 / 18:00', () => {
  const sat = ist(2026, 10, 17, 10); // Saturday
  assert.equal(nextWeekdayAt(sat, 9), ist(2026, 10, 19, 9)); // Monday
  const monNoon = ist(2026, 10, 19, 12);
  assert.deepEqual(nextCommute(monNoon), { t: ist(2026, 10, 19, 18), slot: 'pm' });
  assert.deepEqual(nextCommute(ist(2026, 10, 19, 7)), { t: ist(2026, 10, 19, 9), slot: 'am' });
  assert.deepEqual(nextCommute(ist(2026, 10, 23, 19)), { t: ist(2026, 10, 26, 9), slot: 'am' }); // Fri evening -> Mon
});

const t0 = ist(2026, 10, 20, 0);
const times = Array.from({ length: 48 }, (_, i) => t0 + i * H);
const dry = times.map(() => 0);
const storm = times.map((_, i) => ([17, 18].includes(i) ? 22 : i === 19 ? 4 : i === 16 ? 1 : 0));

test('rainAround sums the hours from 2 h before to 2 h after leaving', () => {
  const w = rainAround(times, storm, ist(2026, 10, 20, 18), 2);
  assert.equal(w.depIndex, 18);
  assert.equal(w.totalMm, 1 + 22 + 22 + 4);
  assert.equal(w.peakMm, 22);
  assert.ok(rainAround(times, storm, ist(2026, 10, 25, 18)).inRange === false);
  assert.equal(hourIndex(times, ist(2026, 10, 20, 9, 30)), 9);
});

test('spotVerdict and tripVerdict follow the documented rules', () => {
  assert.equal(spotVerdict(0.22, { peakMm: 0 }, 1), 'flooded', 'model: 22 cm');
  assert.equal(spotVerdict(0, { peakMm: 12 }, 3), 'flooded', 'heavy rain at a spot reported on 3 days');
  assert.equal(spotVerdict(0, { peakMm: 12 }, 1), 'watch', 'heavy rain at a spot reported once');
  assert.equal(spotVerdict(0.07, { peakMm: 0 }, 1), 'watch');
  assert.equal(spotVerdict(null, { peakMm: 0.5 }, 9), 'clear', 'outside the model, light rain');
  assert.equal(tripVerdict(['clear', 'watch'], { blocked: false, maxDepthM: 0 }), 'watch');
  assert.equal(tripVerdict(['clear'], { blocked: true, maxDepthM: 0 }), 'flooded');
  assert.equal(tripVerdict([], { blocked: false, maxDepthM: 0.08 }), 'watch');
});

test('rainSpell and suggestion: "Heavy rain 17–20 h: leave before 17:00 or after 21:00."', () => {
  const sp = rainSpell(times, storm, ist(2026, 10, 20, 18), 2)!;
  assert.equal(sp.from, ist(2026, 10, 20, 17));
  assert.equal(sp.to, ist(2026, 10, 20, 20), 'the 4 mm hour at 19:00 is still moderate');
  assert.ok(sp.heavy);
  assert.equal(suggestion(sp), 'Heavy rain 17–20 h: leave before 17:00 or after 21:00.');
  assert.equal(suggestion(sp, ist(2026, 10, 20, 22)), 'Heavy rain 17–20 h: leave before 17:00 or after 22:00.');
  assert.equal(rainSpell(times, dry, ist(2026, 10, 20, 18)), null);
  assert.equal(suggestion(null), '');
});

// ------------------------------------------------------------------ shareable link
test('commute link round-trips and keeps other parameters', () => {
  const q = commuteSearch('?pin=560034', { from: [77.62345678, 12.9345], to: [77.6237, 12.9177], dep: '18:00' });
  assert.equal(q, '?pin=560034&from=77.62346,12.93450&to=77.62370,12.91770&dep=18:00');
  assert.deepEqual(parseCommuteLink(q), { from: [77.62346, 12.9345], to: [77.6237, 12.9177], dep: '18:00' });
  assert.equal(parseCommuteLink('?pin=560034&from=77.6,12.9'), null);
  assert.equal(parseCommuteLink('?from=77.6,12.9&to=77.7,12.95&dep=25:00')?.dep, undefined);
});
