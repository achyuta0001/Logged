// Hydrology helpers shared by the district-wide city build (copied from scripts/build-data.mjs,
// which keeps its own copy so the reference pack's build stays byte-for-byte the same).

export const DR = [0, 1, 1, 1, 0, -1, -1, -1];
export const DC = [1, 1, 0, -1, -1, -1, 0, 1];

export class MinHeap {
  constructor(n) { this.k = new Float64Array(n); this.v = new Int32Array(n); this.size = 0; }
  push(key, val) {
    let i = this.size++;
    const { k, v } = this;
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const { k, v } = this;
    const top = v[0], key = k[--this.size], val = v[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1; if (c >= this.size) break;
      if (c + 1 < this.size && k[c + 1] < k[c]) c++;
      if (k[c] >= key) break;
      k[i] = k[c]; v[i] = v[c]; i = c;
    }
    k[i] = key; v[i] = val;
    return top;
  }
}

export function priorityFlood(dem, W, H, eps = 1e-3) {
  const N = W * H, filled = Float64Array.from(dem), closed = new Uint8Array(N), pq = new MinHeap(N);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (r === 0 || c === 0 || r === H - 1 || c === W - 1) { const i = r * W + c; closed[i] = 1; pq.push(filled[i], i); }
  }
  while (pq.size) {
    const i = pq.pop(), r = (i / W) | 0, c = i % W;
    for (let d = 0; d < 8; d++) {
      const rr = r + DR[d], cc = c + DC[d];
      if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
      const j = rr * W + cc;
      if (closed[j]) continue;
      closed[j] = 1;
      filled[j] = Math.max(dem[j], filled[i] + eps);
      pq.push(filled[j], j);
    }
  }
  return filled;
}

export function d8(z, W, H, cell) {
  const N = W * H, dir = new Uint8Array(N).fill(255);
  const dist = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2].map((v) => v * cell);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const i = r * W + c;
    let best = 0, bd = 255;
    for (let d = 0; d < 8; d++) {
      const rr = r + DR[d], cc = c + DC[d];
      if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
      const s = (z[i] - z[rr * W + cc]) / dist[d];
      if (s > best) { best = s; bd = d; }
    }
    dir[i] = bd;
  }
  return dir;
}
export const downstream = (i, d, W) => (d === 255 ? -1 : i + DR[d] * W + DC[d]);

export function accumulate(dir, W, H) {
  const N = W * H, indeg = new Int32Array(N), acc = new Float64Array(N).fill(1);
  for (let i = 0; i < N; i++) { const j = downstream(i, dir[i], W); if (j >= 0) indeg[j]++; }
  const q = new Int32Array(N); let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (!indeg[i]) q[qt++] = i;
  while (qh < qt) {
    const i = q[qh++], j = downstream(i, dir[i], W);
    if (j >= 0) { acc[j] += acc[i]; if (--indeg[j] === 0) q[qt++] = j; }
  }
  return acc;
}

export function gaussian(src, W, H, sigma) {
  const rad = Math.ceil(sigma * 3);
  const k = [];
  let sum = 0;
  for (let i = -rad; i <= rad; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); sum += v; }
  const kn = k.map((v) => v / sum);
  const tmp = new Float64Array(src.length), out = new Float64Array(src.length);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    let a = 0;
    for (let i = -rad; i <= rad; i++) a += kn[i + rad] * src[r * W + Math.min(W - 1, Math.max(0, c + i))];
    tmp[r * W + c] = a;
  }
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    let a = 0;
    for (let i = -rad; i <= rad; i++) a += kn[i + rad] * tmp[Math.min(H - 1, Math.max(0, r + i)) * W + c];
    out[r * W + c] = a;
  }
  return out;
}

// ---------------------------------------------------------------- bare-earth approximation
// GLO-30 is a radar SURFACE model: at 30 m a built block or a tree canopy reads several metres above
// the street, so open plots, wide roads and courtyards between "building blobs" become artificial
// pits. Ground is approximated with a robust rank-order opening (low-percentile erosion followed by
// the symmetric high-percentile dilation): it removes bumps narrower than the window, keeps valleys
// and reproduces planar slopes exactly, and tolerates a few noisy low pixels. The opened surface
// replaces the DSM in proportion to how unreliable each cell is (mapped buildings, trees, built-up
// land use) and is kept where the ground is visible to the sensor (water, open land, wide roads).

/** windowed percentile (q in 0..1) over a (2*rad+1)^2 square, clipped at the grid edges */

// ---------------------------------------------------------------- rasterising (grid G from makeGrid-like objects)
// even-odd scanline fill of polygon rings given in fractional grid coords (x=col, y=row)
// on a grid of size W x H; calls fn(idx) for each cell whose centre is inside.
export function fillRings(rings, W, H, fn) {
  let minY = Infinity, maxY = -Infinity;
  for (const r of rings) for (const p of r) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  const r0 = Math.max(0, Math.ceil(minY - 0.5)), r1 = Math.min(H - 1, Math.floor(maxY - 0.5));
  let count = 0;
  const xs = [];
  for (let r = r0; r <= r1; r++) {
    const yc = r + 0.5;
    xs.length = 0;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[j];
        if ((y1 > yc) !== (y2 > yc)) xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] - 0.5)), c1 = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
      for (let c = c0; c <= c1; c++) { fn(r * W + c); count++; }
    }
  }
  return count;
}

export function polygonsOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}
export function linesOf(geom) {
  if (!geom) return [];
  if (geom.type === 'LineString') return [geom.coordinates];
  if (geom.type === 'MultiLineString') return geom.coordinates;
  if (geom.type === 'Polygon') return geom.coordinates; // e.g. closed drain ways
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat();
  return [];
}

// rasterise polygon geometry onto a grid with `scale` sub-cells per cell
export function fillGeom(G, geom, scale, fn) {
  const W = G.width * scale, H = G.height * scale;
  let n = 0;
  for (const poly of polygonsOf(geom)) {
    const rings = poly.map((ring) => ring.map(([lon, lat]) => [G.col(lon) * scale, G.row(lat) * scale]));
    n += fillRings(rings, W, H, fn);
  }
  return n;
}

// cells touched by a line, sampled every `step` cells, unique & ordered
export function lineCells(G, coords, step = 0.25) {
  const out = [];
  const seen = new Set();
  const push = (lon, lat) => {
    const idx = G.cellOf(lon, lat);
    if (idx >= 0 && !seen.has(idx)) { seen.add(idx); out.push(idx); }
  };
  for (let i = 0; i + 1 < coords.length; i++) {
    const [a, b] = [coords[i], coords[i + 1]];
    const dc = G.col(b[0]) - G.col(a[0]), dr = G.row(b[1]) - G.row(a[1]);
    const nSteps = Math.max(1, Math.ceil(Math.hypot(dc, dr) / step));
    for (let k = 0; k <= nSteps; k++) {
      const t = k / nSteps;
      push(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
    }
  }
  if (coords.length === 1) push(coords[0][0], coords[0][1]);
  return out;
}
