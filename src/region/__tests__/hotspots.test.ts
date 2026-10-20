// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Run: node --test src/region/__tests__/   (Node >= 22.6 strips TS types natively; no deps)
// Sourced flood reports: which spots a pack shows (one rule for the build, calibrate.mjs and the app).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { hotspotsInBBox, inBBox, loadCityHotspots, mergeHotspots } from '../packs.ts';

const ev = (date = '2022-09-05') => ({ date, summary: 'Water entered homes.', source: 'https://example.org/report' });
const spot = (name, coord, extra = {}) => ({ name, coord, events: [ev()], ...extra });
const BBOX = [77.6, 12.9, 77.62, 12.92]; // [west, south, east, north]

test('inBBox: inside, outside and on the edges', () => {
  assert.equal(inBBox([77.61, 12.91], BBOX), true);
  assert.equal(inBBox([77.6, 12.9], BBOX), true); // south-west corner
  assert.equal(inBBox([77.62, 12.92], BBOX), true); // north-east corner
  assert.equal(inBBox([77.5999, 12.91], BBOX), false);
  assert.equal(inBBox([77.61, 12.9201], BBOX), false);
});

test('hotspotsInBBox: keeps the spots inside, in file order, as plain Hotspots', () => {
  const city = [
    spot('A', [77.61, 12.91], { osm: 'node/1' }),
    spot('Outside east', [77.63, 12.91]),
    spot('B', [77.605, 12.915]),
    { name: 'broken', coord: [77.61], events: [] },
    null,
    spot('Outside south', [77.61, 12.89]),
  ];
  const got = hotspotsInBBox(city, BBOX);
  assert.deepEqual(got.map((h) => h.name), ['A', 'B']);
  assert.deepEqual(Object.keys(got[0]).sort(), ['coord', 'events', 'name']); // build-only `osm` dropped
  assert.deepEqual(hotspotsInBBox([], BBOX), []);
});

test("mergeHotspots: city spots in the bbox, then the pack's own spots the city file lacks", () => {
  const city = [spot('Silk Board Junction', [77.61, 12.91]), spot('Far away', [77.7, 13.0])];
  const own = [
    { name: 'silk board  junction', coord: [77.611, 12.911], events: [ev('2017-08-15')] }, // same spot, older copy
    { name: 'Old report', coord: [77.6101, 12.9101], events: [ev('2019-10-22')] }, // ~15 m from Silk Board: same spot
    { name: 'Pack-only spot', coord: [77.615, 12.905], events: [ev('2020-10-23')] },
  ];
  const got = mergeHotspots(own, city, BBOX);
  assert.deepEqual(got.map((h) => h.name), ['Silk Board Junction', 'Pack-only spot']);
  assert.equal(got[0].events[0].date, '2022-09-05'); // the city file is the newer source
  // no city file (offline): the pack's own list as it is
  assert.deepEqual(mergeHotspots(own, [], BBOX).map((h) => h.name), own.map((h) => h.name));
  // a pack without hotspots.json still gets the city spots in its bbox
  assert.deepEqual(mergeHotspots([], city, BBOX).map((h) => h.name), ['Silk Board Junction']);
});

const res = (status, body, type = 'application/json') => ({ ok: status === 200, status, headers: new Headers({ 'content-type': type }), json: async () => structuredClone(body) });

test('loadCityHotspots: reads the array, drops malformed spots, and is empty when unavailable', async () => {
  const good = [spot('A', [77.61, 12.91]), { name: 'no coord', events: [] }];
  assert.deepEqual((await loadCityHotspots('/h.json', async () => res(200, good))).map((h) => h.name), ['A']);
  assert.deepEqual(await loadCityHotspots('/h.json', async () => res(404, {})), []);
  assert.deepEqual(await loadCityHotspots('/h.json', async () => res(200, '<!doctype html>', 'text/html')), []); // dev-server SPA fallback
  assert.deepEqual(await loadCityHotspots('/h.json', async () => res(200, { hotspots: good })), []);
  assert.deepEqual(await loadCityHotspots('/h.json', async () => { throw new TypeError('offline'); }), []);
});

// ---------------------------------------------------------------- committed data
const pub = new URL('../../../public/data/', import.meta.url);
const cityFile = new URL('hotspots-city.json', pub);

test('hotspots-city.json: every spot is named, inside Bengaluru Urban, and every report is dated and sourced', () => {
  if (!existsSync(cityFile)) return;
  const city = JSON.parse(readFileSync(cityFile, 'utf8'));
  assert.ok(Array.isArray(city) && city.length >= 21, `${city.length} spots`);
  const names = new Set();
  for (const h of city) {
    assert.ok(typeof h.name === 'string' && h.name.trim().length > 2, JSON.stringify(h.name));
    assert.ok(!names.has(h.name.toLowerCase()), `duplicate name ${h.name}`);
    names.add(h.name.toLowerCase());
    assert.ok(inBBox(h.coord, [77.3, 12.7, 77.9, 13.3]), `${h.name}: ${h.coord}`);
    if (h.osm !== undefined) assert.match(h.osm, /^(node|way|relation)\/\d+$/, h.name);
    assert.ok(h.events.length > 0, `${h.name}: no report`);
    for (const e of h.events) {
      assert.match(e.date, /^20(1[5-9]|2[0-5])(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/, `${h.name}: date ${e.date}`);
      assert.ok(typeof e.summary === 'string' && e.summary.length > 20, `${h.name}: summary`);
      assert.match(e.source, /^https:\/\/[^\s]+$/, `${h.name}: source`);
    }
  }
});

test("committed packs' hotspots.json hold exactly the city spots inside their grid", () => {
  if (!existsSync(cityFile)) return;
  const city = JSON.parse(readFileSync(cityFile, 'utf8'));
  for (const code of ['560098', '560034', '560071']) {
    const dir = new URL(`pins/${code}/`, pub);
    if (!existsSync(new URL('meta.json', dir))) continue;
    const meta = JSON.parse(readFileSync(new URL('meta.json', dir), 'utf8'));
    const f = new URL('hotspots.json', dir);
    const own = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
    assert.deepEqual(own, hotspotsInBBox(city, meta.bbox), `${code}: run npm run data -- --pin ${code} --hotspots-only`);
  }
});

test('560098 keeps its curated reports (all but Gurudatta Layout, which lies east of its grid)', () => {
  const f = new URL('pins/560098/hotspots.json', pub);
  if (!existsSync(f)) return;
  const names = JSON.parse(readFileSync(f, 'utf8')).map((h) => h.name);
  for (const want of [
    'BEML Layout, RR Nagar',
    'Hosakerehalli Lake',
    'Pramod Layout (near Nayandahalli)',
    'Ideal Homes Township',
    'Kenchenahalli, RR Nagar',
    'Rajarajeshwari Nagar (central)',
    'RR Nagar Arch junction, Mysuru Road',
    'Mysuru Road at Nayandahalli (Vrishabhavathi valley)',
    'Global Village Tech Park (behind RV College)',
    'Mysuru Road at Dubasipalya / RV College',
    'Vrishabhavathi retaining wall, Mylasandra',
  ])
    assert.ok(names.includes(want), want);
});
