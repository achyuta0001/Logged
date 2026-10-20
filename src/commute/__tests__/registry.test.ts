// @ts-nocheck -- node:test types are not part of the browser tsconfig
// The committed commute hotspot registry follows the contract, and the checker catches bad records.
// Run: node --test src/commute/__tests__/registry.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hotspotErrors, parseHotspots, HOTSPOT_TYPES } from '../registry.ts';
import { clusterHotspots, forecastUrl, tracksFromResponses } from '../forecast.ts';

const FILE = new URL('../../../public/data/commute/hotspots.geojson', import.meta.url);
const fc = JSON.parse(fs.readFileSync(FILE, 'utf8'));

test('registry: 60-100 valid hotspots with unique ids', () => {
  const { hotspots, errors } = parseHotspots(fc);
  assert.deepEqual(errors, []);
  assert.ok(hotspots.length >= 60 && hotspots.length <= 100, `${hotspots.length} hotspots`);
  assert.equal(new Set(hotspots.map((h) => h.id)).size, hotspots.length);
  for (const h of hotspots) assert.ok(HOTSPOT_TYPES.includes(h.type));
});

test('registry: every hotspot has a sourced report, OSM ways and a point on its coord', () => {
  for (const f of fc.features) {
    const h = f.properties;
    assert.deepEqual(f.geometry.coordinates, h.coord, h.id);
    assert.ok(h.reportDays >= 1, h.id);
    assert.ok(h.sources.length >= 1 && h.sources.length <= 3, h.id);
    assert.ok(h.ways.length >= 1, `${h.id}: no OSM way`);
    assert.ok(Array.isArray(h.dates) && h.sources.every((s) => h.dates.includes(s.date)), h.id);
  }
});

test('registry: the commute places named in the brief are present when sourced', () => {
  const ids = new Set(fc.features.map((f) => f.properties.id));
  for (const id of ['silk-board-junction', 'hebbal-flyover', 'panathur-railway-underpass', 'kalyan-nagar-underpass', 'domlur-flyover', 'sony-world-junction', 'khodays-circle-underpass', 'sirur-park-junction', 'murphy-town-halasuru'])
    assert.ok(ids.has(id), id);
});

test('checker: rejects bad records', () => {
  const good = fc.features[0].properties;
  assert.deepEqual(hotspotErrors(good), []);
  assert.ok(hotspotErrors({ ...good, id: 'Bad Id' }).length);
  assert.ok(hotspotErrors({ ...good, type: 'bridge' }).length);
  assert.ok(hotspotErrors({ ...good, coord: [0, 0] }).length);
  assert.ok(hotspotErrors({ ...good, lowness: 1.5 }).length);
  assert.ok(hotspotErrors({ ...good, ways: [1.5] }).length);
  assert.ok(hotspotErrors({ ...good, years: [2020] }).length);
  assert.ok(hotspotErrors({ ...good, sources: [{ date: 'x', url: 'y', outlet: '' }] }).length);
  assert.ok(hotspotErrors(null).length);
  const dup = { type: 'FeatureCollection', features: [fc.features[0], fc.features[0]] };
  assert.equal(parseHotspots(dup).hotspots.length, 1);
});

test('forecast: the whole registry fits one multi-location request', () => {
  const hs = fc.features.map((f) => f.properties);
  const cl = clusterHotspots(hs);
  assert.ok(cl.length <= 100, `${cl.length} cells`);
  assert.equal(cl.reduce((n, c) => n + c.ids.length, 0), hs.length);
  const url = forecastUrl(cl.map((c) => c.center));
  assert.match(url, /latitude=[\d.,]+&longitude=[\d.,]+&hourly=precipitation/);
  assert.equal(url.split('latitude=')[1].split('&')[0].split(',').length, cl.length);
});

test('forecast: a multi-location answer becomes one track per hotspot', () => {
  const cl = [{ key: 'a', center: [77.6, 12.9], ids: ['x', 'y'] }, { key: 'b', center: [77.5, 13], ids: ['z'] }];
  const t = [1792434600, 1792438200, 1792441800];
  const body = [{ hourly: { time: t, precipitation: [0, 4, 2] } }, { hourly: { time: t, precipitation: [1, null, 0] }, minutely_15: { time: [t[0]], precipitation: [null] } }];
  const { tracks, resolution } = tracksFromResponses([body], cl);
  assert.equal(resolution, 'hourly');
  assert.equal(tracks.size, 3);
  assert.equal(tracks.get('x'), tracks.get('y'));
  assert.deepEqual(tracks.get('x').mmHr.slice(2, 6), [4, 4, 2, 2]);
  assert.throws(() => tracksFromResponses([body.slice(0, 1)], cl));
});
