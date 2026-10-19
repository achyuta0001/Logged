// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Run: node --test src/pack/__tests__/   (Node >= 22.6 strips TS types natively; no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { decodeLayer, encodeLayer, v2Specs } from '../codec.ts';
import { deriveOsmCells } from '../osm.ts';
import { gunzipSync } from 'node:zlib';
import { lngLatToCell, terrainFromBuffer } from '../../terrain.ts';
import { validateMeta } from '../../region/packs.ts';

// the committed 560098 reference pack (format 2), decoded to the f32 / u8 grids the app works on
const root = new URL('../../../public/data/pins/560098/', import.meta.url);
const meta2 = JSON.parse(readFileSync(new URL('meta.json', root), 'utf8'));
const bin2 = readFileSync(new URL('grids.bin', root));
const t1 = terrainFromBuffer(meta2, bin2.buffer.slice(bin2.byteOffset, bin2.byteOffset + bin2.byteLength));
/** the same grids in the format-1 layout (f32 / u8 as is): what a v1 grids.bin of this pack holds */
const bin = Buffer.concat(Object.keys(meta2.layers).map((k) => Buffer.from(t1.grids[k].buffer, t1.grids[k].byteOffset, t1.grids[k].byteLength)));

/** encode the 560098 grids as a v2 pack (what build-data writes) */
function toV2(t) {
  const W = t.meta.width;
  const specs = v2Specs(t.grids);
  const layers = {};
  const parts = [];
  let off = 0;
  for (const name of Object.keys(t.meta.layers)) {
    if (name === 'filled') {
      layers.filled = { offset: 0, length: W * t.meta.height, dtype: 'f32', derived: true };
      continue;
    }
    const enc = encodeLayer(t.grids[name], W, specs[name]);
    layers[name] = { offset: off, ...enc.info };
    parts.push(enc.bytes);
    off += enc.bytes.byteLength;
    const pad = (4 - (off % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      off += pad;
    }
  }
  const buf = new Uint8Array(off);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.byteLength;
  }
  return { meta: { ...t.meta, format: 2, layers }, buf: buf.buffer };
}

test('codec: u16 delta + shuffle round-trips within half a step, including wrap-around steps', () => {
  const W = 50;
  const v = Float32Array.from({ length: W * 40 }, (_, i) => 880 + Math.sin(i / 7) * 3 + (i % 97 === 0 ? 30 : 0));
  for (const spec of [
    { dtype: 'u16', base: 870, scale: 0.001, delta: true, shuffle: true },
    { dtype: 'u16', base: 870, scale: 0.001 },
    { dtype: 'u16', base: 870, scale: 0.01, delta: true },
  ]) {
    const { bytes, info } = encodeLayer(v, W, spec);
    const buf = new Uint8Array(bytes.byteLength + 8);
    buf.set(bytes, 8);
    const out = decodeLayer(buf.buffer, { offset: 8, ...info }, W);
    let err = 0;
    for (let i = 0; i < v.length; i++) err = Math.max(err, Math.abs(out[i] - v[i]));
    assert.ok(err <= spec.scale / 2 + 1e-4, `${JSON.stringify(spec)}: max error ${err}`);
  }
});

test('codec: log2 flow accumulation keeps ~0.04 % relative precision; u8 masks are exact', () => {
  const W = 20;
  const acc = Float32Array.from({ length: 400 }, (_, i) => 1 + i * i * 13);
  const a = encodeLayer(acc, W, { dtype: 'u16', log2: true, scale: 2048 });
  const out = decodeLayer(a.bytes.buffer, { offset: 0, ...a.info }, W);
  for (let i = 0; i < acc.length; i++) assert.ok(Math.abs(out[i] / acc[i] - 1) < 4e-4, `${acc[i]} -> ${out[i]}`);
  const m = Uint8Array.from({ length: 400 }, (_, i) => i % 3 === 0);
  const b = encodeLayer(m, W, { dtype: 'u8' });
  assert.deepEqual(Array.from(decodeLayer(b.bytes.buffer, { offset: 0, ...b.info }, W)), Array.from(m));
});

test('v2 pack of the 560098 grids: valid, 2.5x+ smaller gzipped, every layer within its quantisation step', () => {
  const v2 = toV2(t1);
  assert.deepEqual(validateMeta(v2.meta, v2.buf.byteLength), []);
  // the f32 baseline holds already-quantised values, which gzip better than the build's raw floats did
  // (the original format-1 grids.bin gzipped 2.9x+ larger), so this ratio is a lower bound
  const gz1 = gzipSync(bin).length;
  const gz2 = gzipSync(new Uint8Array(v2.buf)).length;
  assert.ok(gz2 < gz1 / 2.5, `gzipped ${gz2} vs ${gz1}`);
  const t2 = terrainFromBuffer(v2.meta, v2.buf);
  const half = (k) => v2.meta.layers[k].scale / 2 + 1e-4; // + float32 rounding at ~900 m
  const tol = { elevation: half('elevation'), depressionDepth: half('depressionDepth'), filled: half('elevation') + half('depressionDepth'), hand: half('hand'), impervious: half('impervious') };
  assert.ok(tol.elevation < 0.003, 'elevation kept to millimetres');
  for (const [name, tl] of Object.entries(tol)) {
    let err = 0;
    for (let i = 0; i < t1.grids[name].length; i++) err = Math.max(err, Math.abs(t2.grids[name][i] - t1.grids[name][i]));
    assert.ok(err <= tl, `${name}: max error ${err}`);
  }
  for (const name of ['flowDir', 'drainMask', 'lakeMask', 'boundaryMask']) assert.deepEqual(Array.from(t2.grids[name]), Array.from(t1.grids[name]), name);
  for (let i = 0; i < t1.grids.flowAccum.length; i++) assert.ok(Math.abs(t2.grids.flowAccum[i] / t1.grids.flowAccum[i] - 1) < 4e-4);
});

test('the 560098 pack stores OSM without cells, and they derive onto its grid (560098)', () => {
  const osm = JSON.parse(gunzipSync(readFileSync(new URL('osm.geojson.gz', root))).toString('utf8'));
  assert.equal(osm.format, 2);
  assert.ok(osm.features.every((f) => f.properties.cell === undefined && f.properties.cells === undefined), 'v2 leaves cell / cells out');
  deriveOsmCells(osm, meta2);
  const n = meta2.width * meta2.height;
  const inGrid = osm.features.filter((f) => Number.isInteger(f.properties.cell) && f.properties.cell >= 0 && f.properties.cell < n).length;
  // the OSM query is padded beyond the grid, so a few features lie outside it (cell -1)
  assert.ok(inGrid / osm.features.length > 0.95, `centroid cells on the grid ${inGrid}/${osm.features.length}`);
  for (const f of osm.features) {
    const p = f.properties;
    if (f.geometry?.type === 'Point') assert.equal(p.cell, lngLatToCell(meta2, f.geometry.coordinates[0], f.geometry.coordinates[1]), p.id);
    if (p.kind === 'road' || p.kind === 'drain') {
      assert.ok(Array.isArray(p.cells), `${p.id}: cells`);
      assert.equal(new Set(p.cells).size, p.cells.length, `${p.id}: unique cells`);
      assert.ok(p.cells.every((c) => c >= 0 && c < n), `${p.id}: cells on the grid`);
    }
  }
  const roads = osm.features.filter((f) => f.properties.kind === 'road');
  assert.ok(roads.length > 1000 && roads.filter((f) => f.properties.cells.length > 0).length / roads.length > 0.95, 'roads sample cells');
});
