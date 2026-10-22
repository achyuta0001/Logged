// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Run: node --test src/region/__tests__/   (Node >= 22.6 strips TS types natively; no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { allowedPacksUrl, fallbackIndex, hotspotsInBBox, inflowCaveat, loadPinIndex, mergeHotspots, packBase, packsRoot, searchPins, validateMeta, validatePinIndex } from '../packs.ts';
import { terrainFromBuffer } from '../../terrain.ts';
import { SimCore } from '../../sim/core.ts';
import { bowlAndChannel, noisyTerrain } from '../../sim/__tests__/synthetic.ts';

const pin = (code, extra = {}) => ({
  code,
  name: `Place ${code}`,
  relation: Number(code),
  bbox: [77.5, 12.9, 77.52, 12.92],
  centroid: [77.51, 12.91],
  areaKm2: 4.2,
  districtShare: 1,
  ...extra,
});
const index = (pins) => ({ version: 1, generated: '2026-10-17', district: { relation: 2020589, name: 'Bengaluru Urban' }, rule: 'test', pins });
const pack = (path, extra = {}) => ({ path, format: 2, bytes: 10, gzipBytes: 5, built: '2026-10-17', sources: ['test'], ...extra });
const fakeFetch = (map) => async (url) => {
  const body = map[url];
  if (body === undefined) return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
  return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => structuredClone(body) };
};

// ---------------------------------------------------------------- schema
test('index schema: a valid index passes', () => {
  assert.deepEqual(validatePinIndex(index([pin('560098', { pack: pack('.', { format: 1 }) }), pin('560034', { susceptibility: 0.7, pack: pack('560034') }), pin('560103')])), []);
});

test('index schema: catches bad codes, duplicates, bboxes, shares and packs', () => {
  const errs = validatePinIndex(
    index([
      pin('56003'),
      pin('560034'),
      pin('560034'),
      pin('560035', { bbox: [77.6, 12.9, 77.5, 12.92] }),
      pin('560036', { districtShare: 1.4, susceptibility: 2 }),
      pin('560037', { pack: pack('../etc', { format: 9 }) }),
    ]),
  );
  for (const want of ['6 digits', 'duplicate', 'bad bbox', 'districtShare', 'susceptibility', 'pack.path', 'pack.format']) assert.ok(errs.some((e) => e.includes(want)), `expected an error about ${want}: ${errs.join(' | ')}`);
  assert.deepEqual(validatePinIndex({ version: 2, pins: 'x' }).length, 2);
});

test('committed index.json (when present) is valid and contains 560098 with a pack', () => {
  const f = new URL('../../../public/data/pins/index.json', import.meta.url);
  if (!existsSync(f)) return;
  const idx = JSON.parse(readFileSync(f, 'utf8'));
  assert.deepEqual(validatePinIndex(idx), []);
  assert.ok(idx.pins.find((p) => p.code === '560098')?.pack);
});

test('meta schema: the 560098 reference pack is valid against its grids.bin', () => {
  const root = new URL('../../../public/data/pins/560098/', import.meta.url);
  const meta = JSON.parse(readFileSync(new URL('meta.json', root), 'utf8'));
  const bytes = readFileSync(new URL('grids.bin', root)).byteLength;
  assert.deepEqual(validateMeta(meta, bytes), []);
  assert.ok(validateMeta({ ...meta, width: meta.width + 1 }, bytes).some((e) => e.includes('length')));
  assert.ok(validateMeta(meta, bytes - 100).some((e) => e.includes('past the end')));
});

test('meta schema: inflow points must sit on the grid with an area and a time-area histogram', () => {
  const root = new URL('../../../public/data/pins/560098/', import.meta.url);
  const meta = JSON.parse(readFileSync(new URL('meta.json', root), 'utf8'));
  const n = meta.width * meta.height;
  const ok = { cell: 5, at: [77.5, 12.9], areaKm2: 3, impervious: 0.6, timeArea: [0.4, 0.6] };
  assert.deepEqual(validateMeta({ ...meta, inflow: [ok] }), []);
  const errs = validateMeta({ ...meta, inflow: [{ ...ok, cell: n }, { ...ok, areaKm2: 0 }, { ...ok, impervious: 2 }, { ...ok, timeArea: [] }] });
  for (const want of ['inflow[0]: cell', 'inflow[1]: bad areaKm2', 'inflow[2]: impervious', 'inflow[3]: bad timeArea']) assert.ok(errs.some((e) => e.startsWith(want)), `${want}: ${errs.join(' | ')}`);
  // inflow edge runs lie along a grid side
  assert.deepEqual(validateMeta({ ...meta, inflowEdge: [[0, 0, meta.width - 1], [3, 2, 5]] }), []);
  const bad = validateMeta({ ...meta, inflowEdge: [[4, 0, 1], [0, 3, 2], [2, 0, meta.height], [1, 0.5, 2]] });
  assert.equal(bad.filter((e) => e.startsWith('inflowEdge[')).length, 4, bad.join(' | '));
  // committed sample packs that carry inflow points validate against their own grids
  for (const code of ['560034', '560071']) {
    const dir = new URL(`../../../public/data/pins/${code}/`, import.meta.url);
    if (!existsSync(new URL('meta.json', dir))) continue;
    const m = JSON.parse(readFileSync(new URL('meta.json', dir), 'utf8'));
    assert.deepEqual(validateMeta(m, readFileSync(new URL('grids.bin', dir)).byteLength), [], code);
  }
});

test('caveat: says how much upstream inflow is simulated and how much is left out', () => {
  const c = (extra, area = 5) => inflowCaveat(pin('560034', { areaKm2: area, pack: pack('560034', extra) }));
  assert.equal(c({}), null, 'nothing known: no line');
  assert.equal(c({ upstreamOutsideKm2: 3 }), null, 'small upstream area: no line');
  assert.match(c({ upstreamOutsideKm2: 97.4 }).text, /About 97 km² .* leaves that inflow out/);
  assert.match(c({ upstreamOutsideKm2: 96.4, inflowKm2: 94.3 }).text, /^Water from about 94 km² upstream is routed in/);
  const part = c({ upstreamOutsideKm2: 120, inflowKm2: 60 }).text;
  assert.match(part, /Water from 60 km² .* about 60 km² more is left out/);
  assert.match(c({ upstreamOutsideKm2: 4, inflowKm2: 3.5 }).text, /about 3\.5 km²/);
  assert.ok(c({ upstreamOutsideKm2: 96.4, inflowKm2: 94.3 }).tip.includes('Clark'));
});

// ---------------------------------------------------------------- loader
test('loader: reads index.json and resolves pack URLs', async () => {
  const idx = index([pin('560098', { pack: pack('.', { format: 1 }) }), pin('560034', { pack: pack('560034') })]);
  const got = await loadPinIndex('/packs', fakeFetch({ '/packs/index.json': idx }));
  assert.equal(got.pins.length, 2);
  assert.equal(packBase('/packs', got.pins[1]), '/packs/560034');
  assert.equal(packBase('/packs', got.pins[0]), '/data/pins/560098'); // "." (old indexes) = the bundled reference pack
  assert.throws(() => packBase('/packs', pin('560103')), /No data pack/);
});

test('loader: missing or invalid index falls back to the reference pack', async () => {
  const a = await loadPinIndex('/packs', fakeFetch({}));
  assert.deepEqual(a.pins.map((p) => p.code), ['560098']);
  const b = await loadPinIndex('/packs', fakeFetch({ '/packs/index.json': { version: 7 } }));
  assert.deepEqual(b.pins.map((p) => p.code), ['560098']);
  assert.deepEqual(validatePinIndex(fallbackIndex()), []);
});

test('loader: a hosted index without 560098 still gets the reference pack', async () => {
  const got = await loadPinIndex('https://example.org/p', fakeFetch({ 'https://example.org/p/index.json': index([pin('560034', { pack: pack('560034') }), pin('560098')]) }));
  const ref = got.pins.find((p) => p.code === '560098');
  assert.equal(ref.pack.path, '.');
  // it loads from the copy bundled with the app, not from the hosted root
  assert.equal(packBase('https://example.org/p', ref), '/data/pins/560098');
  assert.equal(packBase('https://example.org/p', got.pins.find((p) => p.code === '560034')), 'https://example.org/p/560034');
});

// ---------------------------------------------------------------- search
test('search: by number, prefix, name and locality', () => {
  const idx = index([
    pin('560034', { name: 'Koramangala', localities: ['ST Bed Layout'] }),
    pin('560102', { name: 'HSR Layout', localities: ['Agara'] }),
    pin('560103', { name: 'Bellandur', localities: ['Kadubeesanahalli', 'Devarabisanahalli'] }),
    pin('560098', { name: 'Rajarajeshwari Nagar', pack: pack('.', { format: 1 }) }),
  ]);
  assert.deepEqual(searchPins(idx, '560103').map((p) => p.code), ['560103']);
  assert.deepEqual(searchPins(idx, '5601').map((p) => p.code), ['560102', '560103']);
  assert.deepEqual(searchPins(idx, '560 034').map((p) => p.code), ['560034']);
  assert.equal(searchPins(idx, 'bellandur')[0].code, '560103');
  assert.equal(searchPins(idx, 'hsr')[0].code, '560102');
  assert.equal(searchPins(idx, 'kadubee')[0].code, '560103');
  assert.equal(searchPins(idx, 'rajarajeshwari')[0].code, '560098');
  assert.deepEqual(searchPins(idx, 'x'), []);
});

// ---------------------------------------------------------------- switching regions
/** a synthetic pack in the on-disk format: meta.json + grids.bin bytes */
function synthPack(code, g) {
  const n = g.width * g.height;
  const layers = {};
  const parts = [];
  let off = 0;
  const add = (name, arr, dtype) => {
    layers[name] = { offset: off, length: n, dtype };
    const b = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    parts.push(b);
    off += b.byteLength;
    const pad = (4 - (off % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      off += pad;
    }
  };
  const f = (v) => Float32Array.from({ length: n }, (_, i) => (typeof v === 'function' ? v(i) : v));
  add('elevation', g.elevation, 'f32');
  add('filled', g.elevation, 'f32');
  add('depressionDepth', f(0), 'f32');
  add('flowAccum', f(1), 'f32');
  add('flowDir', new Uint8Array(n).fill(255), 'u8');
  add('hand', f(1), 'f32');
  add('impervious', g.impervious, 'f32');
  add('drainMask', g.drainMask ?? new Uint8Array(n), 'u8');
  add('lakeMask', g.lakeMask ?? new Uint8Array(n), 'u8');
  add('boundaryMask', new Uint8Array(n).fill(1), 'u8');
  const buf = new Uint8Array(off);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.byteLength;
  }
  const meta = {
    pincode: code,
    name: `Synthetic ${code}`,
    bbox: [77.5, 12.9, 77.5 + (g.width * g.cellSizeM) / 108000, 12.9 + (g.height * g.cellSizeM) / 110574],
    width: g.width,
    height: g.height,
    cellSizeM: g.cellSizeM,
    boundary: { type: 'Polygon', coordinates: [[[77.5, 12.9], [77.51, 12.9], [77.51, 12.91], [77.5, 12.9]]] },
    layers,
    stats: { minElev: 0, maxElev: 1 },
    sources: ['synthetic test fixture'],
  };
  return { meta, buf: buf.buffer };
}

function runPack(p, rain) {
  const t = terrainFromBuffer(p.meta, p.buf);
  const g = t.grids;
  const s = new SimCore(
    { width: p.meta.width, height: p.meta.height, cellSizeM: p.meta.cellSizeM, elevation: g.elevation, impervious: g.impervious, drainMask: g.drainMask, lakeMask: g.lakeMask },
    { drainCapacityMmHr: 20, infiltrationMmHr: 5, drainBlockage: 0.3 },
  );
  for (const mm of rain) s.stepHour(mm);
  return { vol: s.totalVolume(), budget: { ...s.budget } };
}

test('switching regions: synthetic packs of different sizes load, validate and simulate independently', () => {
  const a = synthPack('560001', bowlAndChannel(80));
  const b = synthPack('560002', noisyTerrain(140, 110));
  for (const p of [a, b]) assert.deepEqual(validateMeta(p.meta, p.buf.byteLength), [], p.meta.pincode);
  const rain = [30, 60, 10, 0];
  const a1 = runPack(a, rain);
  const b1 = runPack(b, rain);
  const a2 = runPack(a, rain); // back to A after B: identical, nothing carried over
  assert.ok(a1.vol > 0 && b1.vol > 0);
  assert.equal(a2.vol, a1.vol);
  assert.deepEqual(a2.budget, a1.budget);
  assert.notEqual(a1.vol, b1.vol);
});

test('?packs= is honoured only for this origin or an allowed https host', () => {
  const site = 'https://achyuta0001.github.io';
  assert.equal(packsRoot('?packs=/Logged/mirror/pins/', site), '/Logged/mirror/pins');
  assert.equal(packsRoot('?packs=https://achyuta0001.github.io/Logged/pins', 'http://localhost:5173'), 'https://achyuta0001.github.io/Logged/pins');
  assert.equal(packsRoot('?packs=http://localhost:5173/x', 'http://localhost:5173'), 'http://localhost:5173/x');
  for (const q of ['https://evil.example/pins', '//evil.example/pins', 'http://achyuta0001.github.io/pins', 'https://achyuta0001.github.io.evil.example/pins', 'javascript:alert(1)']) {
    assert.equal(allowedPacksUrl(q, site), false, q);
    assert.equal(packsRoot(`?packs=${encodeURIComponent(q)}`, site), '/data/pins', q);
  }
});

test('hotspot sources that are not http(s) lose their link on load', () => {
  const bbox = [77, 12, 78, 13];
  const ev = (source) => ({ date: '2024-10-20', summary: 's', source });
  const spot = { name: 'A', coord: [77.5, 12.5], events: [ev('https://example.org/a'), ev('javascript:alert(1)'), ev('data:text/html,x'), ev(42)] };
  const [h] = hotspotsInBBox([spot], bbox);
  assert.deepEqual(h.events.map((e) => e.source), ['https://example.org/a', '', '', '']);
  const own = { name: 'B', coord: [77.9, 12.9], events: [ev('javascript:alert(1)')] };
  const merged = mergeHotspots([own], [], bbox);
  assert.equal(merged[0].events[0].source, '');
});
