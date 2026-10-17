#!/usr/bin/env node
// Renders hillshade + depressionDepth + flowAccum + drains/lakes + boundary to .cache/preview.png
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/meta.json'), 'utf8'));
const buf = fs.readFileSync(path.join(ROOT, 'public/data/grids.bin'));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const L = {};
for (const [k, v] of Object.entries(meta.layers)) L[k] = v.dtype === 'f32' ? new Float32Array(ab, v.offset, v.length) : new Uint8Array(ab, v.offset, v.length);
const { width: W, height: H, cellSizeM: cs } = meta;
const SCALE = 2;
const png = new PNG({ width: W * SCALE, height: H * SCALE });
const z = L.elevation;
const hasEdge = (i, mask) => { const r = (i / W) | 0, c = i % W; return mask[i] && ((r > 0 && !mask[i - W]) || (r < H - 1 && !mask[i + W]) || (c > 0 && !mask[i - 1]) || (c < W - 1 && !mask[i + 1])); };
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
  const i = r * W + c;
  const zl = z[r * W + Math.max(0, c - 1)], zr = z[r * W + Math.min(W - 1, c + 1)];
  const zu = z[Math.max(0, r - 1) * W + c], zd = z[Math.min(H - 1, r + 1) * W + c];
  const dx = (zr - zl) / (2 * cs) * 3, dy = (zd - zu) / (2 * cs) * 3; // 3x vertical exaggeration
  const nx = -dx, ny = dy, nz = 1, n = Math.hypot(nx, ny, nz);
  const lx = -0.5, ly = 0.5, lz = 0.707; // light from NW
  let shade = Math.max(0, (nx * lx + ny * ly + nz * lz) / n);
  // tint by elevation
  const t = (z[i] - meta.stats.minElev) / (meta.stats.maxElev - meta.stats.minElev);
  let R = 120 + 110 * shade * (0.6 + 0.4 * t), Gc = R, B = R;
  const fa = Math.log10(L.flowAccum[i]);
  if (fa > 2.2) { const a = Math.min(1, (fa - 2.2) / 1.5) * 0.7; R = R * (1 - a) + 20 * a; Gc = Gc * (1 - a) + 60 * a; B = B * (1 - a) + 140 * a; }
  const dd = L.depressionDepth[i];
  if (dd > 0.2) { const a = Math.min(0.85, 0.3 + dd / 3); R = R * (1 - a) + 0 * a; Gc = Gc * (1 - a) + 170 * a; B = B * (1 - a) + 255 * a; }
  if (L.lakeMask[i]) { R = 40; Gc = 210; B = 210; }
  if (L.drainMask[i]) { R = 230; Gc = 30; B = 30; }
  if (hasEdge(i, L.boundaryMask)) { R = 255; Gc = 200; B = 0; }
  for (let y = 0; y < SCALE; y++) for (let x = 0; x < SCALE; x++) {
    const p = ((r * SCALE + y) * W * SCALE + c * SCALE + x) * 4;
    png.data[p] = R; png.data[p + 1] = Gc; png.data[p + 2] = B; png.data[p + 3] = 255;
  }
}
const out = path.join(ROOT, '.cache', 'preview.png');
fs.writeFileSync(out, PNG.sync.write(png));
console.log('wrote', out);
