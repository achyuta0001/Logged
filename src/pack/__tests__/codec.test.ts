// @ts-nocheck -- node:test types are not part of the browser tsconfig
// Run: node --test src/pack/__tests__/   (Node >= 22.6 strips TS types natively; no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { decodeLayer, encodeLayer, v2Specs } from '../codec.ts';
import { deriveOsmCells } from '../osm.ts';
import { terrainFromBuffer } from '../../terrain.ts';
import { validateMeta } from '../../region/packs.ts';

const root = new URL('../../../public/data/', import.meta.url);
const meta1 = JSON.parse(readFileSync(new URL('meta.json', root), 'utf8'));
const bin = readFileSync(new URL('grids.bin', root));
const t1 = terrainFromBuffer(meta1, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));

/** re-encode the 560098 reference grids as a v2 pack (what build-data writes) */
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

test('v2 pack of the 560098 grids: valid, 3x+ smaller gzipped, every layer within its quantisation step', () => {
  const v2 = toV2(t1);
  assert.deepEqual(validateMeta(v2.meta, v2.buf.byteLength), []);
  const gz1 = gzipSync(bin).length;
  const gz2 = gzipSync(new Uint8Array(v2.buf)).length;
  assert.ok(gz2 < gz1 / 2.9, `gzipped ${gz2} vs ${gz1}`);
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

test('derived OSM cells match the cells the build stored (560098)', () => {
  const osm = JSON.parse(readFileSync(new URL('osm.geojson', root), 'utf8'));
  const stripped = structuredClone(osm);
  for (const f of stripped.features) {
    delete f.properties.cell;
    delete f.properties.cells;
  }
  deriveOsmCells(stripped, meta1);
  let cellOk = 0, shared = 0, union = 0;
  stripped.features.forEach((f, i) => {
    const o = osm.features[i].properties;
    if (f.properties.cell === o.cell) cellOk++;
    if (o.cells) {
      const a = new Set(o.cells);
      const b = new Set(f.properties.cells);
      for (const c of a) if (b.has(c)) shared++;
      union += new Set([...a, ...b]).size;
    }
  });
  // the build's grid origin is unrounded and facility points are stored rounded to 1e-6 deg, so a
  // rare centroid on a cell edge lands in the neighbouring cell
  assert.ok(cellOk / osm.features.length > 0.995, `centroid cells ${cellOk}/${osm.features.length}`);
  // line samples see the same rounding: compare as sets of cells
  assert.ok(shared / union > 0.99, `line cells overlap ${(shared / union).toFixed(4)}`);
});
