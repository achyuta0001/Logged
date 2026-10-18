// Upstream catchments that drain into a pack's grid from outside it (M4: simulated inflow).
//
// `npm run data:city` routes water over the whole district on a 60 m grid (Copernicus GLO-30 with OSM
// drains and lakes burned in, priority-flood, D8) and saves the result as .cache/city/flow60.{json,bin}.
// For any pack grid, every D8 flow path that crosses from outside the grid's bbox into it is one inflow
// point. Its catchment counts only cells outside the bbox (water that leaves the grid and comes back is
// not counted twice) and is summarised for the lumped model in src/sim/inflow.ts:
//   areaKm2     contributing area outside the grid
//   impervious  mean sealed share (district OSM cover; build-data rescales it to the pack's own estimate)
//   drainShare  share of the area within ~500 m of a mapped drain (where the grid's inlets act)
//   tankShare   share of the area whose flow path passes a mapped lake / tank; tankM3 = their flood
//               cushion (lake area x lakeFreeboardM, the grid's own rule)
//   timeArea    share of the area per hour of travel time to the grid edge; storageH = Clark storage
//               coefficient (0.5 x Tc, Tc = 95th percentile travel time, 0.25..6 h)
// Travel time follows the D8 path: shallow concentrated flow on paved ground at 6.2 sqrt(s) m/s
// (NRCS TR-55) until 0.5 km² drains through a cell, then Manning channel flow (n = 0.03, hydraulic
// radius 0.4 A^0.3 m with A in km²); speeds clamped to 0.05..1.5 and 0.3..3 m/s, slopes to >= 0.1 %.
import fs from 'node:fs';
import path from 'node:path';
import { lakeFreeboardM } from '../../src/sim/core.ts';

const DR = [0, 1, 1, 1, 0, -1, -1, -1];
const DC = [1, 1, 0, -1, -1, -1, 0, 1];
export const FLOW_BASE = path.join('.cache', 'city', 'flow60');
const CHANNEL_KM2 = 0.5;
const SERVE_M = 500;
const MAX_BINS = 48;

/** grid helpers for a regular lon/lat grid (same conventions as makeGrid in build-city / build-data) */
export function gridOf({ w, n, width, height, dLat, dLon, cellM }) {
  const s = n - height * dLat, e = w + width * dLon;
  return {
    w, s, e, n, width, height, dLat, dLon, cellM, cellArea: cellM * cellM,
    col: (lon) => (lon - w) / dLon,
    row: (lat) => (n - lat) / dLat,
    lon: (c) => w + (c + 0.5) * dLon,
    lat: (r) => n - (r + 0.5) * dLat,
    cellOf(lon, lat) {
      const c = Math.floor((lon - w) / dLon), r = Math.floor((n - lat) / dLat);
      return c < 0 || r < 0 || c >= width || r >= height ? -1 : r * width + c;
    },
  };
}

/** save the district routing: dir (D8, 255 = outlet), acc (cells), dem (m), imp (0..1), lake, drain (0/1) */
export function writeFlowGrids(root, G, { dir, acc, dem, imp, lake, drain }) {
  const N = G.width * G.height;
  const parts = [
    ['dir', Uint8Array.from(dir)],
    ['lake', Uint8Array.from(lake)],
    ['drain', Uint8Array.from(drain)],
    ['acc', Float32Array.from(acc)],
    ['dem', Float32Array.from(dem)],
    ['imp', Float32Array.from(imp)],
  ];
  const layers = {};
  const bufs = [];
  let off = 0;
  for (const [name, arr] of parts) {
    if (arr.length !== N) throw new Error(`flow layer ${name}: ${arr.length} != ${N}`);
    const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    layers[name] = { offset: off, dtype: arr instanceof Float32Array ? 'f32' : 'u8' };
    bufs.push(b);
    off += b.length;
    const pad = (4 - (off % 4)) % 4;
    if (pad) { bufs.push(Buffer.alloc(pad)); off += pad; }
  }
  const header = { version: 1, w: G.w, n: G.n, width: G.width, height: G.height, dLat: G.dLat, dLon: G.dLon, cellM: Math.sqrt(G.cellArea), layers };
  fs.mkdirSync(path.join(root, path.dirname(FLOW_BASE)), { recursive: true });
  fs.writeFileSync(path.join(root, `${FLOW_BASE}.bin`), Buffer.concat(bufs));
  fs.writeFileSync(path.join(root, `${FLOW_BASE}.json`), JSON.stringify(header));
}

/** load the district routing written by npm run data:city (null when it has not been built) */
export function readFlowGrids(root) {
  const hf = path.join(root, `${FLOW_BASE}.json`), bf = path.join(root, `${FLOW_BASE}.bin`);
  if (!fs.existsSync(hf) || !fs.existsSync(bf)) return null;
  const h = JSON.parse(fs.readFileSync(hf, 'utf8'));
  const raw = fs.readFileSync(bf);
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const N = h.width * h.height;
  const layer = (k) => (h.layers[k].dtype === 'f32' ? new Float32Array(buf, h.layers[k].offset, N) : new Uint8Array(buf, h.layers[k].offset, N));
  return { G: gridOf(h), dir: layer('dir'), acc: layer('acc'), dem: layer('dem'), imp: layer('imp'), lake: layer('lake'), drain: layer('drain') };
}

/** lake components (4-connected) with their area, and cells within ~500 m of a mapped drain; cached on flow */
function prepare(flow) {
  if (flow._prep) return flow._prep;
  const { G, lake, drain } = flow;
  const W = G.width, H = G.height, N = W * H;
  const comp = new Int32Array(N).fill(-1);
  const area = [];
  const stack = [];
  for (let s = 0; s < N; s++) {
    if (!lake[s] || comp[s] >= 0) continue;
    const id = area.length;
    let cnt = 0;
    comp[s] = id;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      cnt++;
      const r = (i / W) | 0, c = i % W;
      for (const j of [c + 1 < W ? i + 1 : -1, c > 0 ? i - 1 : -1, r + 1 < H ? i + W : -1, r > 0 ? i - W : -1])
        if (j >= 0 && lake[j] && comp[j] < 0) { comp[j] = id; stack.push(j); }
    }
    area.push(cnt * G.cellArea);
  }
  const cushion = Float64Array.from(area, (a) => lakeFreeboardM(a));
  // within SERVE_M (4-neighbour steps) of a drain cell, like the grid's inlet service areas
  let anyDrain = false;
  const served = new Uint8Array(N);
  const dist = new Int32Array(N).fill(-1);
  const q = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (drain[i]) { dist[i] = 0; q[qt++] = i; anyDrain = true; }
  const maxSteps = Math.ceil(SERVE_M / G.cellM);
  while (qh < qt) {
    const i = q[qh++];
    served[i] = 1;
    if (dist[i] >= maxSteps) continue;
    const r = (i / W) | 0, c = i % W;
    for (const j of [c + 1 < W ? i + 1 : -1, c > 0 ? i - 1 : -1, r + 1 < H ? i + W : -1, r > 0 ? i - W : -1])
      if (j >= 0 && dist[j] < 0) { dist[j] = dist[i] + 1; q[qt++] = j; }
  }
  // no mapped drains at all: the grid then spreads its whole capacity everywhere (core.ts)
  if (!anyDrain) served.fill(1);
  flow._prep = { comp, cushion, served, tt: new Float64Array(N), via: new Uint8Array(N), q: new Int32Array(N) };
  return flow._prep;
}

/** flow speed (m/s) from cell k to its downstream neighbour over length L (velocity method, see header) */
function speed(slope, areaKm2) {
  const s = Math.sqrt(Math.max(0.001, slope));
  if (areaKm2 < CHANNEL_KM2) return Math.min(1.5, Math.max(0.05, 6.2 * s));
  const R = 0.4 * Math.pow(areaKm2, 0.3);
  return Math.min(3, Math.max(0.3, (1 / 0.03) * Math.pow(R, 2 / 3) * s));
}

const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Inflow points for a grid covering bbox [w, s, e, n]: every 60 m D8 path entering the bbox from
 * outside, with its outside catchment. Returns { totalKm2, points } (points sorted by area, largest first;
 * lon/lat = centre of the first 60 m cell inside the bbox).
 */
export function outsideInflow(flow, [w, s, e, n]) {
  const { G, dir, acc, dem, imp, lake } = flow;
  const W = G.width, H = G.height, A = G.cellArea;
  const { comp, cushion, served, tt, via, q } = prepare(flow);
  const inside = (i) => {
    const lon = G.lon(i % W), lat = G.lat((i / W) | 0);
    return lon >= w && lon <= e && lat >= s && lat <= n;
  };
  const down = (i) => (dir[i] === 255 ? -1 : i + DR[dir[i]] * W + DC[dir[i]]);
  const c0 = Math.max(0, Math.floor(G.col(w)) - 2), c1 = Math.min(W - 1, Math.ceil(G.col(e)) + 2);
  const r0 = Math.max(0, Math.floor(G.row(n)) - 2), r1 = Math.min(H - 1, Math.ceil(G.row(s)) + 2);
  const points = [];
  let total = 0;
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) {
      const i = r * W + c, j = down(i);
      if (j < 0 || inside(i) || !inside(j)) continue;
      // walk the catchment upstream of the crossing, outside cells only
      let qh = 0, qt = 0;
      q[qt++] = i;
      tt[i] = 0;
      via[i] = lake[i] ? 1 : 0;
      let cnt = 0, impSum = 0, servedN = 0, viaN = 0, tankM3 = 0;
      const times = [];
      while (qh < qt) {
        const u = q[qh++];
        cnt++;
        impSum += imp[u];
        servedN += served[u];
        viaN += via[u];
        if (comp[u] >= 0) tankM3 += A * cushion[comp[u]];
        times.push(tt[u]);
        const ur = (u / W) | 0, uc = u % W;
        for (let d = 0; d < 8; d++) {
          const kr = ur - DR[d], kc = uc - DC[d]; // neighbour k whose direction d points at u
          if (kr < 0 || kc < 0 || kr >= H || kc >= W) continue;
          const k = kr * W + kc;
          if (dir[k] !== d || inside(k)) continue;
          const L = G.cellM * (d % 2 ? Math.SQRT2 : 1);
          tt[k] = tt[u] + L / speed((dem[k] - dem[u]) / L, (acc[k] * A) / 1e6);
          via[k] = via[u] || lake[k] ? 1 : 0;
          q[qt++] = k;
        }
      }
      const hist = new Array(MAX_BINS).fill(0);
      for (const t of times) hist[Math.min(MAX_BINS - 1, Math.floor(t / 3600))]++;
      while (hist.length > 1 && hist[hist.length - 1] === 0) hist.pop();
      times.sort((a, b) => a - b);
      const tcH = times[Math.floor(0.95 * (times.length - 1))] / 3600;
      const areaKm2 = (cnt * A) / 1e6;
      total += areaKm2;
      points.push({
        lon: G.lon(j % W),
        lat: G.lat((j / W) | 0),
        areaKm2,
        impervious: impSum / cnt,
        drainShare: servedN / cnt,
        tankShare: viaN / cnt,
        tankM3,
        timeArea: hist.map((v) => r3(v / cnt)),
        tcH,
        storageH: Math.min(6, Math.max(0.25, 0.5 * tcH)),
      });
    }
  points.sort((a, b) => b.areaKm2 - a.areaKm2);
  return { totalKm2: total, points };
}

/** mean of a district layer over the 60 m cells whose centres lie in bbox (NaN if none) */
export function meanInside(flow, [w, s, e, n], arr) {
  const { G } = flow;
  const c0 = Math.max(0, Math.ceil(G.col(w) - 0.5)), c1 = Math.min(G.width - 1, Math.floor(G.col(e) - 0.5));
  const r0 = Math.max(0, Math.ceil(G.row(n) - 0.5)), r1 = Math.min(G.height - 1, Math.floor(G.row(s) - 0.5));
  let sum = 0, cnt = 0;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { sum += arr[r * G.width + c]; cnt++; }
  return cnt ? sum / cnt : NaN;
}

/**
 * Where to inject a crossing's inflow on a pack grid: snap to the strongest flow line within `snap`
 * cells (the 60 m and the pack's own D8 differ by a cell or two), then follow the pack's D8 downstream
 * until `inset` cells clear of every edge (edge cells let water leave the grid). If the pack's flow
 * runs back out near that edge, step straight inwards instead.
 */
export function injectionCell({ width: W, height: H }, flowDir, flowAccum, col, row, { snap = 4, inset = 6 } = {}) {
  const r0 = Math.min(H - 1, Math.max(0, Math.floor(row))), c0 = Math.min(W - 1, Math.max(0, Math.floor(col)));
  let best = r0 * W + c0, bestA = -1;
  for (let dr = -snap; dr <= snap; dr++)
    for (let dc = -snap; dc <= snap; dc++) {
      const r = r0 + dr, c = c0 + dc;
      if (r < 0 || c < 0 || r >= H || c >= W) continue;
      const k = r * W + c;
      if (flowAccum[k] > bestA) { bestA = flowAccum[k]; best = k; }
    }
  const edgeDist = (k) => Math.min(k % W, W - 1 - (k % W), (k / W) | 0, H - 1 - ((k / W) | 0));
  let i = best;
  for (let step = 0; step < 3 * inset && edgeDist(i) < inset; step++) {
    const d = flowDir[i];
    if (d === 255 || d === undefined) break;
    const r = ((i / W) | 0) + DR[d], c = (i % W) + DC[d];
    if (r < 0 || c < 0 || r >= H || c >= W) break;
    i = r * W + c;
  }
  if (edgeDist(i) >= inset) return i;
  const r = (best / W) | 0, c = best % W;
  const lim = (v, m) => Math.min(Math.max(v, Math.min(inset, (m - 1) >> 1)), m - 1 - Math.min(inset, (m - 1) >> 1));
  return lim(r, H) * W + lim(c, W);
}

/**
 * Pack inflow points: map each crossing onto the pack grid, merge crossings that land on the same cell,
 * keep those draining at least `minKm2` (largest first, at most `maxPoints`). `impScale` rescales the
 * district imperviousness to the pack's own estimate. Returns { points, simulatedKm2, totalKm2 }.
 */
export function packInflow(flow, grid, flowDir, flowAccum, { minKm2 = 0.25, maxPoints = 24, impScale = 1 } = {}) {
  const { totalKm2, points: raw } = outsideInflow(flow, [grid.w, grid.s, grid.e, grid.n]);
  const byCell = new Map();
  for (const p of raw) {
    const cell = injectionCell(grid, flowDir, flowAccum, grid.col(p.lon), grid.row(p.lat));
    const m = byCell.get(cell);
    if (!m) { byCell.set(cell, { ...p, cell, timeArea: p.timeArea.map((v) => v * p.areaKm2) }); continue; }
    const a = m.areaKm2 + p.areaKm2;
    for (const k of ['impervious', 'drainShare', 'tankShare', 'tcH']) m[k] = (m[k] * m.areaKm2 + p[k] * p.areaKm2) / a;
    m.tankM3 += p.tankM3;
    p.timeArea.forEach((v, b) => (m.timeArea[b] = (m.timeArea[b] ?? 0) + v * p.areaKm2));
    if (p.areaKm2 > m.areaKm2 - p.areaKm2) { m.lon = p.lon; m.lat = p.lat; }
    m.areaKm2 = a;
  }
  const merged = [...byCell.values()].map((m) => ({ ...m, timeArea: m.timeArea.map((v) => (v ?? 0) / m.areaKm2) })).sort((a, b) => b.areaKm2 - a.areaKm2);
  const kept = merged.filter((m) => m.areaKm2 >= minKm2).slice(0, maxPoints);
  const points = kept.map((m) => ({
    cell: m.cell,
    at: [Math.round(m.lon * 1e5) / 1e5, Math.round(m.lat * 1e5) / 1e5],
    areaKm2: r3(m.areaKm2),
    impervious: r3(Math.min(0.98, Math.max(0, m.impervious * impScale))),
    drainShare: r3(m.drainShare),
    tankShare: r3(m.tankShare),
    tankM3: Math.round(m.tankM3),
    timeArea: m.timeArea.map(r3),
    storageH: Math.round(Math.min(6, Math.max(0.25, 0.5 * m.tcH)) * 100) / 100,
  }));
  return { points, simulatedKm2: kept.reduce((s, m) => s + m.areaKm2, 0), totalKm2, edge: inflowEdge(flow, grid) };
}

/**
 * Pack-grid edge stretches where the district routing has land outside the grid draining in, as runs
 * [side, from, to] (side 0 north, 1 south, 2 west, 3 east; from..to inclusive, pack cells along that side).
 * They are inflow boundaries, not outfalls: where a valley or a lake is cut off by the grid edge, the pack's
 * own DEM slopes outwards and a free outfall would drain the inflow straight back out. The 60 m routing
 * places a crossing a cell or two off the pack's finer DEM, and a valley entering at a slant crosses in
 * patches, so open gaps up to `gapM` between closed cells are closed and each stretch is widened by
 * `marginM` at both ends (along its own side only: a stream clipping a corner still leaves by the other).
 */
export function inflowEdge(flow, grid, { gapM = 300, marginM = 150 } = {}) {
  const { G, dir } = flow;
  const W = G.width, H = G.height;
  const { w, s, e, n } = grid;
  const inside = (i) => {
    const lon = G.lon(i % W), lat = G.lat((i / W) | 0);
    return lon >= w && lon <= e && lat >= s && lat <= n;
  };
  const drainsIn = (k) => {
    if (k < 0 || dir[k] === 255 || inside(k)) return false;
    const r = ((k / W) | 0) + DR[dir[k]], c = (k % W) + DC[dir[k]];
    return r >= 0 && c >= 0 && r < H && c < W && inside(r * W + c);
  };
  const gap = Math.max(0, Math.round(gapM / grid.cellM)), margin = Math.max(0, Math.round(marginM / grid.cellM));
  const runs = [];
  for (let side = 0; side < 4; side++) {
    const len = side < 2 ? grid.width : grid.height;
    const closed = new Uint8Array(len);
    for (let t = 0; t < len; t++) {
      // the district cell half a district cell beyond this edge cell: always the first ring outside
      const lon = side < 2 ? grid.lon(t) : side === 2 ? w - 0.5 * G.dLon : e + 0.5 * G.dLon;
      const lat = side >= 2 ? grid.lat(t) : side === 0 ? n + 0.5 * G.dLat : s - 0.5 * G.dLat;
      closed[t] = drainsIn(G.cellOf(lon, lat)) ? 1 : 0;
    }
    for (let t = 0, last = -1; t < len; t++) {
      if (!closed[t]) continue;
      if (last >= 0 && t - last - 1 <= gap) closed.fill(1, last + 1, t);
      last = t;
    }
    const core = Uint8Array.from(closed);
    for (let t = 0; t < len; t++) if (core[t]) closed.fill(1, Math.max(0, t - margin), Math.min(len, t + margin + 1));
    for (let t = 0; t < len; t++) {
      if (!closed[t]) continue;
      let u = t;
      while (u + 1 < len && closed[u + 1]) u++;
      runs.push([side, t, u]);
      t = u;
    }
  }
  return runs;
}
