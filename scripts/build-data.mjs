#!/usr/bin/env node
// Data pipeline for the 560098 (Rajarajeshwari Nagar) flood prototype.
// Produces public/data/{meta.json,grids.bin,osm.geojson,depressions.json}.
// Raw downloads are cached in .cache/ so re-runs are fast and offline-safe.
//
//   node scripts/build-data.mjs            (DEM=copernicus by default, falls back to terrarium)
//   DEM=terrarium node scripts/build-data.mjs
//   REFRESH=1 node scripts/build-data.mjs  (ignore cached OSM)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import osmtogeojson from 'osmtogeojson';
import * as turf from '@turf/turf';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'public', 'data');
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const PINCODE = '560098';
const RELATION_ID = 17817376;
const APPROX_BBOX = [77.499, 12.8924, 77.5323, 12.9363]; // W S E N (fallback only)
const PAD_DEG = 0.006;
const CELL_M = 15;
const UA = 'flood-prototype-560098/0.1 (research prototype; contact achyuta0001@gmail.com)';
const OVERPASS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const log = (...a) => console.log('[data]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- downloads
async function fetchRetry(url, opts = {}, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status} ${url}`);
      if (res.status === 404) break;
    } catch (e) {
      lastErr = e;
    }
    await sleep(1500 * 2 ** i);
  }
  throw lastErr;
}

async function overpass(query, cacheName) {
  const file = path.join(CACHE, cacheName);
  if (fs.existsSync(file) && !process.env.REFRESH) return JSON.parse(fs.readFileSync(file, 'utf8'));
  let lastErr;
  for (let round = 0; round < 3; round++) {
    for (const ep of OVERPASS) {
      try {
        log(`overpass ${cacheName} via ${new URL(ep).host} ...`);
        const res = await fetchRetry(
          ep,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(query),
          },
          2,
        );
        const text = await res.text();
        const json = JSON.parse(text);
        if (!json.elements) throw new Error('no elements');
        if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(json.remark);
        fs.writeFileSync(file, text);
        return json;
      } catch (e) {
        lastErr = e;
        log(`  failed: ${e.message}`);
      }
    }
    await sleep(5000 * (round + 1));
  }
  throw lastErr;
}

// ---------------------------------------------------------------- OSM
async function loadOsm() {
  const [w, s, e, n] = [APPROX_BBOX[0] - 0.012, APPROX_BBOX[1] - 0.012, APPROX_BBOX[2] + 0.012, APPROX_BBOX[3] + 0.012];
  const bb = `${s},${w},${n},${e}`;
  const q = `[out:json][timeout:240][bbox:${bb}];
(
  relation(${RELATION_ID});
  way["building"];
  relation["building"];
  way["highway"];
  way["waterway"];
  relation["waterway"];
  nwr["natural"~"^(water|wetland|wood|scrub|grassland)$"];
  nwr["water"];
  nwr["landuse"];
  nwr["leisure"~"^(park|garden|playground|pitch|nature_reserve|recreation_ground|sports_centre|stadium)$"];
  nwr["amenity"~"^(school|college|university|kindergarten|hospital|clinic|doctors|marketplace|police|fire_station|place_of_worship|bus_station)$"];
  nwr["healthcare"];
  nwr["shop"~"^(supermarket|mall|department_store)$"];
  nwr["highway"="bus_stop"];
  nwr["public_transport"];
  nwr["railway"~"^(station|halt|subway_entrance)$"];
  nwr["power"="substation"];
  node["place"];
);
out body;
>;
out skel qt;`;
  const raw = await overpass(q, 'osm-raw.json');
  log(`OSM elements: ${raw.elements.length}`);
  return osmtogeojson(raw, { flatProperties: false });
}

// ---------------------------------------------------------------- grid
function makeGrid(boundaryGeom) {
  let [w, s, e, n] = boundaryGeom ? turf.bbox(boundaryGeom) : APPROX_BBOX;
  w -= PAD_DEG; s -= PAD_DEG; e += PAD_DEG; n += PAD_DEG;
  const lat0 = (s + n) / 2;
  const mPerDegLat = 110574;
  const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const dLat = CELL_M / mPerDegLat;
  const dLon = CELL_M / mPerDegLon;
  const width = Math.ceil((e - w) / dLon);
  const height = Math.ceil((n - s) / dLat);
  e = w + width * dLon;
  s = n - height * dLat;
  return {
    w, s, e, n, width, height, dLat, dLon, n_cells: width * height, cellArea: CELL_M * CELL_M,
    col: (lon) => (lon - w) / dLon,
    row: (lat) => (n - lat) / dLat,
    lon: (c) => w + (c + 0.5) * dLon,
    lat: (r) => n - (r + 0.5) * dLat,
    cellOf(lon, lat) {
      const c = Math.floor((lon - w) / dLon), r = Math.floor((n - lat) / dLat);
      if (c < 0 || r < 0 || c >= width || r >= height) return -1;
      return r * width + c;
    },
  };
}

// even-odd scanline fill of polygon rings given in fractional grid coords (x=col, y=row)
// on a grid of size W x H; calls fn(idx) for each cell whose centre is inside.
function fillRings(rings, W, H, fn) {
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

function polygonsOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}
function linesOf(geom) {
  if (!geom) return [];
  if (geom.type === 'LineString') return [geom.coordinates];
  if (geom.type === 'MultiLineString') return geom.coordinates;
  if (geom.type === 'Polygon') return geom.coordinates; // e.g. closed drain ways
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat();
  return [];
}

// rasterise polygon geometry onto a grid with `scale` sub-cells per cell
function fillGeom(G, geom, scale, fn) {
  const W = G.width * scale, H = G.height * scale;
  let n = 0;
  for (const poly of polygonsOf(geom)) {
    const rings = poly.map((ring) => ring.map(([lon, lat]) => [G.col(lon) * scale, G.row(lat) * scale]));
    n += fillRings(rings, W, H, fn);
  }
  return n;
}

// cells touched by a line, sampled every `step` cells, unique & ordered
function lineCells(G, coords, step = 0.25) {
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

function lineLengthM(coords) {
  let L = 0;
  for (let i = 0; i + 1 < coords.length; i++) {
    const [a, b] = [coords[i], coords[i + 1]];
    const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
    L += Math.hypot((b[0] - a[0]) * 111320 * Math.cos(lat), (b[1] - a[1]) * 110574);
  }
  return L;
}

// ---------------------------------------------------------------- DEM
async function demCopernicus(G) {
  // GLO-30 1x1 deg tile covering N12-13, E077-078
  const name = 'Copernicus_DSM_COG_10_N12_00_E077_00_DEM';
  const cacheFile = path.join(CACHE, `cop30_${G.w.toFixed(4)}_${G.n.toFixed(4)}_${G.width}x${G.height}.json`);
  let win;
  if (fs.existsSync(cacheFile)) win = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  else {
    const { fromUrl } = await import('geotiff');
    const url = `https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`;
    log('Copernicus GLO-30 COG window read ...');
    const tiff = await fromUrl(url, { headers: { 'User-Agent': UA } });
    const img = await tiff.getImage();
    const [ox, oy] = img.getOrigin();
    const [rx, ry] = img.getResolution(); // ry negative
    const x0 = Math.floor((G.w - ox) / rx) - 3, x1 = Math.ceil((G.e - ox) / rx) + 3;
    const y0 = Math.floor((G.n - oy) / ry) - 3, y1 = Math.ceil((G.s - oy) / ry) + 3;
    const [band] = await img.readRasters({ window: [x0, y0, x1, y1] });
    win = { ox, oy, rx, ry, x0, y0, w: x1 - x0, h: y1 - y0, data: Array.from(band, (v) => Math.round(v * 100) / 100) };
    fs.writeFileSync(cacheFile, JSON.stringify(win));
  }
  const sample = (lon, lat) => {
    // pixel-is-area: pixel centre at origin + (i+0.5)*res
    const fx = (lon - win.ox) / win.rx - 0.5 - win.x0;
    const fy = (lat - win.oy) / win.ry - 0.5 - win.y0;
    return bilinear(win.data, win.w, win.h, fx, fy);
  };
  return resample(G, sample);
}

async function demTerrarium(G, z = 15) {
  const n2 = 2 ** z;
  const tx = (lon) => ((lon + 180) / 360) * n2;
  const ty = (lat) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n2; };
  const X0 = Math.floor(tx(G.w)), X1 = Math.floor(tx(G.e)), Y0 = Math.floor(ty(G.n)), Y1 = Math.floor(ty(G.s));
  const tiles = new Map();
  for (let x = X0; x <= X1; x++) for (let y = Y0; y <= Y1; y++) {
    const f = path.join(CACHE, 'terrarium', `${z}_${x}_${y}.png`);
    if (!fs.existsSync(f)) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const res = await fetchRetry(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
      fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
    }
    const png = PNG.sync.read(fs.readFileSync(f));
    const el = new Float32Array(256 * 256);
    for (let i = 0; i < el.length; i++) el[i] = png.data[i * 4] * 256 + png.data[i * 4 + 1] + png.data[i * 4 + 2] / 256 - 32768;
    tiles.set(`${x}_${y}`, el);
  }
  log(`terrarium z${z}: ${tiles.size} tiles`);
  // mosaic
  const MW = (X1 - X0 + 1) * 256, MH = (Y1 - Y0 + 1) * 256;
  const mosaic = new Float32Array(MW * MH);
  for (const [k, el] of tiles) {
    const [x, y] = k.split('_').map(Number);
    for (let r = 0; r < 256; r++) mosaic.set(el.subarray(r * 256, r * 256 + 256), ((y - Y0) * 256 + r) * MW + (x - X0) * 256);
  }
  return resample(G, (lon, lat) => bilinear(mosaic, MW, MH, (tx(lon) - X0) * 256 - 0.5, (ty(lat) - Y0) * 256 - 0.5));
}

function bilinear(data, w, h, fx, fy) {
  fx = Math.min(Math.max(fx, 0), w - 1.001); fy = Math.min(Math.max(fy, 0), h - 1.001);
  const x = Math.floor(fx), y = Math.floor(fy), ax = fx - x, ay = fy - y;
  const i = y * w + x;
  return (data[i] * (1 - ax) + data[i + 1] * ax) * (1 - ay) + (data[i + w] * (1 - ax) + data[i + w + 1] * ax) * ay;
}
function resample(G, sample) {
  const out = new Float64Array(G.n_cells);
  for (let r = 0; r < G.height; r++) for (let c = 0; c < G.width; c++) out[r * G.width + c] = sample(G.lon(c), G.lat(r));
  return out;
}
function gaussian(src, W, H, sigma) {
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

// ---------------------------------------------------------------- hydrology
const DR = [0, 1, 1, 1, 0, -1, -1, -1];
const DC = [1, 1, 0, -1, -1, -1, 0, 1];

class MinHeap {
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

function priorityFlood(dem, W, H, eps = 1e-3) {
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

function d8(z, W, H, cell) {
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
const downstream = (i, d, W) => (d === 255 ? -1 : i + DR[d] * W + DC[d]);

function accumulate(dir, W, H) {
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

// ---------------------------------------------------------------- classification
const ROAD_TYPES = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service', 'road']);
const ROAD_WIDTH = { motorway: 22, trunk: 20, primary: 14, secondary: 11, tertiary: 8, unclassified: 6, residential: 6, living_street: 5, service: 4, road: 6 };
const roadWidth = (h) => ROAD_WIDTH[h.replace('_link', '')] ?? 7;
const DRAIN_TYPES = new Set(['drain', 'canal', 'stream', 'ditch', 'river']);
const BURN_M = { river: 2.5, canal: 2.5, drain: 1.5, stream: 1.5, ditch: 1.0 };

function classify(t) {
  if (!t) return null;
  const a = t.amenity;
  if (['school', 'college', 'university', 'kindergarten'].includes(a)) return 'school';
  if (a === 'hospital' || t.healthcare === 'hospital') return 'hospital';
  if (a === 'clinic' || a === 'doctors' || ['clinic', 'doctor', 'centre'].includes(t.healthcare)) return 'clinic';
  const metroish = t.station === 'subway' || t.subway === 'yes' || /metro|bmrcl/i.test(`${t.network || ''} ${t.operator || ''} ${t.name || ''}`);
  if ((t.railway === 'station' || t.public_transport === 'station') && metroish) return 'metro';
  if (t.highway === 'bus_stop' || a === 'bus_station' || (t.public_transport === 'platform' && t.bus === 'yes')) return 'bus_stop';
  if (a === 'marketplace' || ['supermarket', 'mall', 'department_store'].includes(t.shop)) return 'market';
  if (a === 'police') return 'police';
  if (a === 'fire_station') return 'fire_station';
  if (a === 'place_of_worship') return 'worship';
  if (t.power === 'substation') return 'substation';
  if (t.building && t.building !== 'no') return 'building';
  if (t.highway && ROAD_TYPES.has(t.highway) && t.area !== 'yes') return 'road';
  if (t.waterway && DRAIN_TYPES.has(t.waterway)) return 'drain';
  if (t.natural === 'water' || t.water || ['reservoir', 'basin'].includes(t.landuse) || t.waterway === 'riverbank') return 'water';
  if (['park', 'garden', 'nature_reserve', 'recreation_ground'].includes(t.leisure) || t.landuse === 'recreation_ground') return 'park';
  return null;
}

function landuseImperv(t) {
  if (!t) return null;
  if (t.natural === 'water' || t.water || ['reservoir', 'basin'].includes(t.landuse)) return 0;
  if (['commercial', 'retail', 'industrial', 'railway', 'construction', 'garages'].includes(t.landuse)) return 0.8;
  if (['residential'].includes(t.landuse)) return 0.75;
  if (['education', 'institutional', 'religious', 'military'].includes(t.landuse) || ['school', 'college', 'university', 'hospital'].includes(t.amenity)) return 0.55;
  if (['park', 'garden', 'playground', 'pitch', 'nature_reserve', 'recreation_ground'].includes(t.leisure) || ['grass', 'forest', 'meadow', 'farmland', 'orchard', 'village_green', 'recreation_ground', 'cemetery', 'greenfield', 'plant_nursery', 'farmyard'].includes(t.landuse) || ['wood', 'scrub', 'grassland', 'wetland'].includes(t.natural)) return t.landuse === 'cemetery' ? 0.3 : 0.2;
  return null;
}
// lower priority = painted first (smaller areas painted later override)

const round6 = (x) => Math.round(x * 1e6) / 1e6;
function roundCoords(c) { return typeof c[0] === 'number' ? [round6(c[0]), round6(c[1])] : c.map(roundCoords); }
function dedupeRing(c) {
  // drop consecutive duplicate points after rounding
  if (typeof c[0] === 'number') return c;
  if (typeof c[0][0] === 'number') return c.filter((p, i) => i === 0 || p[0] !== c[i - 1][0] || p[1] !== c[i - 1][1]);
  return c.map(dedupeRing);
}

// ---------------------------------------------------------------- main
async function main() {
  const t0 = Date.now();
  const fc = await loadOsm();

  // boundary
  const bFeat = fc.features.find((f) => f.id === `relation/${RELATION_ID}`);
  if (!bFeat || !/Polygon/.test(bFeat.geometry?.type)) throw new Error('boundary relation not found as polygon');
  const boundary = { type: bFeat.geometry.type, coordinates: roundCoords(bFeat.geometry.coordinates) };
  const G = makeGrid(boundary);
  const { width: W, height: H } = G;
  const N = W * H;
  log(`grid ${W} x ${H} = ${N} cells @ ${CELL_M} m, bbox ${[G.w, G.s, G.e, G.n].map((v) => v.toFixed(5)).join(',')}`);

  // ------------------------------------------------ DEM
  const sources = [];
  let dem, demName = (process.env.DEM || 'copernicus').toLowerCase();
  if (demName === 'copernicus') {
    try {
      dem = await demCopernicus(G);
      sources.push('DEM: Copernicus DEM GLO-30 (DSM) © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA; all rights reserved; free licence. Accessed via public AWS bucket copernicus-dem-30m (no login), bilinear-resampled to 15 m');
    } catch (e) {
      log(`Copernicus failed (${e.message}); falling back to terrarium`);
      demName = 'terrarium';
    }
  }
  if (!dem) {
    dem = await demTerrarium(G, 15);
    sources.push('DEM: AWS Open Data Terrain Tiles (Mapzen terrarium z15; SRTM courtesy of NASA/USGS, public domain; attribution per github.com/tilezen/joerd), bilinear-resampled to 15 m');
  }
  const SIGMA = 1.5;
  dem = gaussian(dem, W, H, SIGMA);
  sources.push(`DEM smoothed with Gaussian sigma=${SIGMA} cells; OSM drains burned (-1..2.5 m) and lakes lowered 0.5 m`);
  sources.push('© OpenStreetMap contributors, ODbL 1.0 (openstreetmap.org/copyright), fetched once via Overpass API and cached');

  // ------------------------------------------------ rasterise OSM
  const S = 3; // sub-cells per cell for coverage fractions
  const SW = W * S, SH = H * S;
  const drainMask = new Uint8Array(N), lakeMask = new Uint8Array(N), boundaryMask = new Uint8Array(N);
  const burn = new Float64Array(N);
  const subBuilding = new Uint8Array(SW * SH), subRoad = new Uint8Array(SW * SH);
  const baseImp = new Float64Array(N).fill(0.6);
  const baseArea = new Float64Array(N).fill(Infinity); // smallest landuse polygon wins
  const lakeName = new Map(); // cell -> name

  fillGeom(G, boundary, 1, (i) => (boundaryMask[i] = 1));

  const counts = {};
  const outFeatures = [];
  const metroSeen = new Set();
  const namedRoads = []; // for labels: {name, coords}
  const places = [];

  for (const f of fc.features) {
    const t = f.properties?.tags || {};
    const geom = f.geometry;
    if (!geom) continue;
    if (f.id === `relation/${RELATION_ID}`) continue;
    if (geom.type === 'Point' && t.place && t.name) places.push({ name: t.name, lon: geom.coordinates[0], lat: geom.coordinates[1] });

    // landuse imperviousness (polygons only)
    const li = landuseImperv(t);
    if (li !== null && /Polygon/.test(geom.type)) {
      const area = turf.area(geom);
      fillGeom(G, geom, 1, (i) => { if (area < baseArea[i]) { baseArea[i] = area; baseImp[i] = li; } });
    }

    const kind = classify(t);
    if (!kind) continue;

    // centroid & bbox filter
    let cen;
    try { cen = turf.centroid(geom).geometry.coordinates; } catch { continue; }
    const cell = G.cellOf(cen[0], cen[1]);
    if (cell < 0) continue;

    const props = { id: f.id, kind, cell };
    if (t.name) props.name = t.name;
    let outGeom = geom;

    if (kind === 'building') {
      if (!/Polygon/.test(geom.type)) continue;
      let h = parseFloat(t.height);
      if (!(h > 0)) { const lv = parseFloat(t['building:levels']); h = lv > 0 ? lv * 3.2 : 7; }
      props.height = Math.round(h * 10) / 10;
      fillGeom(G, geom, S, (i) => (subBuilding[i] = 1));
    } else if (kind === 'road') {
      const lines = linesOf(geom);
      if (!lines.length) continue;
      props.highway = t.highway;
      const cells = [];
      const set = new Set();
      let L = 0;
      for (const ln of lines) {
        for (const c of lineCells(G, ln, 0.5)) if (!set.has(c)) { set.add(c); cells.push(c); }
        L += lineLengthM(ln);
        // road surface on sub-grid
        const halfW = roadWidth(t.highway) / 2 / (CELL_M / S); // in sub-cells
        for (let k = 0; k + 1 < ln.length; k++) {
          const ax = G.col(ln[k][0]) * S, ay = G.row(ln[k][1]) * S, bx = G.col(ln[k + 1][0]) * S, by = G.row(ln[k + 1][1]) * S;
          const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - halfW)), x1 = Math.min(SW - 1, Math.ceil(Math.max(ax, bx) + halfW));
          const y0 = Math.max(0, Math.floor(Math.min(ay, by) - halfW)), y1 = Math.min(SH - 1, Math.ceil(Math.max(ay, by) + halfW));
          const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-12;
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const px = x + 0.5, py = y + 0.5;
            const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
            if (Math.hypot(px - ax - u * dx, py - ay - u * dy) <= halfW) subRoad[y * SW + x] = 1;
          }
        }
      }
      if (!cells.length) continue;
      props.cells = cells;
      props.lengthM = Math.round(L);
      if (t.name) namedRoads.push({ name: t.name, lines });
    } else if (kind === 'drain') {
      const lines = linesOf(geom);
      const cells = [];
      const set = new Set();
      const b = BURN_M[t.waterway] ?? 1.5;
      for (const ln of lines) for (const c of lineCells(G, ln, 0.25)) {
        drainMask[c] = 1; burn[c] = Math.max(burn[c], b);
        if (!set.has(c)) { set.add(c); cells.push(c); }
      }
      if (!cells.length) continue;
      props.cells = cells;
      props.lengthM = Math.round(lines.reduce((s, l) => s + lineLengthM(l), 0));
      props.waterway = t.waterway;
    } else if (kind === 'water') {
      if (!/Polygon/.test(geom.type)) continue;
      const n = fillGeom(G, geom, 1, (i) => { lakeMask[i] = 1; burn[i] = Math.max(burn[i], 0.5); if (t.name) lakeName.set(i, t.name); });
      if (!n) { lakeMask[cell] = 1; if (t.name) lakeName.set(cell, t.name); }
    } else if (kind === 'park') {
      if (!/Polygon/.test(geom.type)) continue;
    } else {
      // point-like facilities -> export as centroid Point
      if (kind === 'metro') {
        const key = (t.name || f.id).toLowerCase().replace(/metro|station|\s+/g, '');
        if (metroSeen.has(key)) continue;
        metroSeen.add(key);
      }
      outGeom = { type: 'Point', coordinates: cen };
    }
    counts[kind] = (counts[kind] || 0) + 1;
    outFeatures.push({ type: 'Feature', geometry: { type: outGeom.type, coordinates: dedupeRing(roundCoords(outGeom.coordinates)) }, properties: props });
  }

  // ------------------------------------------------ conditioned DEM
  const elevation = new Float64Array(N);
  for (let i = 0; i < N; i++) elevation[i] = dem[i] - burn[i];

  // ------------------------------------------------ impervious
  const impervious = new Float32Array(N);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    let nb = 0, nr = 0;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const si = (r * S + y) * SW + c * S + x;
      if (subBuilding[si]) nb++; else if (subRoad[si]) nr++;
    }
    const i = r * W + c, fb = nb / (S * S), fr = nr / (S * S);
    impervious[i] = lakeMask[i] ? 0 : Math.min(1, fb * 0.95 + fr * 0.9 + (1 - fb - fr) * baseImp[i]);
  }

  // ------------------------------------------------ hydrology
  const filled = priorityFlood(elevation, W, H, 1e-3);
  const depressionDepth = new Float32Array(N);
  for (let i = 0; i < N; i++) depressionDepth[i] = filled[i] - elevation[i];
  const flowDir = d8(filled, W, H, CELL_M);
  const flowAccum = accumulate(flowDir, W, H);

  // HAND
  const ACC_THRESH = Math.round(150000 / G.cellArea); // ~0.15 km2 contributing area
  const isDrainage = (i) => flowAccum[i] >= ACC_THRESH || drainMask[i] || lakeMask[i];
  const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => filled[a] - filled[b]);
  const target = new Int32Array(N).fill(-1);
  for (const i of order) {
    if (isDrainage(i)) { target[i] = i; continue; }
    const j = downstream(i, flowDir[i], W);
    target[i] = j >= 0 && target[j] >= 0 ? target[j] : i;
  }
  const hand = new Float32Array(N);
  for (let i = 0; i < N; i++) hand[i] = Math.max(0, elevation[i] - elevation[target[i]]);

  // ------------------------------------------------ depressions
  const MIN_DEPTH = 0.2, MIN_CELLS = 4;
  const label = new Int32Array(N).fill(-1);
  const comps = [];
  const stack = [];
  for (let s = 0; s < N; s++) {
    if (label[s] !== -1 || depressionDepth[s] <= MIN_DEPTH) continue;
    const id = comps.length, cells = [];
    label[s] = id; stack.push(s);
    while (stack.length) {
      const i = stack.pop(); cells.push(i);
      const r = (i / W) | 0, c = i % W;
      for (let d = 0; d < 8; d++) {
        const rr = r + DR[d], cc = c + DC[d];
        if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
        const j = rr * W + cc;
        if (label[j] === -1 && depressionDepth[j] > MIN_DEPTH) { label[j] = id; stack.push(j); }
      }
    }
    comps.push(cells);
  }
  // keep only big enough
  const keep = new Int32Array(comps.length).fill(-1);
  const deps = [];
  comps.forEach((cells, k) => { if (cells.length >= MIN_CELLS) { keep[k] = deps.length; deps.push({ cells, catch: 0 }); } });
  for (let i = 0; i < N; i++) if (label[i] >= 0) label[i] = keep[label[i]];

  // catchment: steepest-descent path on the ORIGINAL (unfilled, conditioned) DEM until it enters a depression
  const rawDir = d8(elevation, W, H, CELL_M);
  const dest = new Int32Array(N).fill(-2); // -2 unknown, -1 none
  const path_ = [];
  for (let s = 0; s < N; s++) {
    if (dest[s] !== -2) continue;
    let i = s; path_.length = 0;
    let result = -1;
    for (;;) {
      if (label[i] >= 0) { result = label[i]; break; }
      if (dest[i] !== -2) { result = dest[i]; break; }
      path_.push(i);
      dest[i] = -3; // in-progress guard
      const j = downstream(i, rawDir[i], W);
      if (j < 0) { result = -1; break; }
      if (dest[j] === -3) { result = -1; break; }
      i = j;
    }
    for (const p of path_) dest[p] = result;
  }
  for (let i = 0; i < N; i++) { const d = label[i] >= 0 ? label[i] : dest[i]; if (d >= 0) deps[d].catch++; }

  // labels
  const dToM = (lon1, lat1, lon2, lat2) => Math.hypot((lon2 - lon1) * 111320 * Math.cos((lat1 * Math.PI) / 180), (lat2 - lat1) * 110574);
  function nearestRoad(lon, lat) {
    let best = Infinity, name;
    for (const rd of namedRoads) for (const ln of rd.lines) for (let k = 0; k + 1 < ln.length; k++) {
      const [a, b] = [ln[k], ln[k + 1]];
      const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110574;
      const ax = (a[0] - lon) * kx, ay = (a[1] - lat) * ky, bx = (b[0] - lon) * kx, by = (b[1] - lat) * ky;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-12;
      const u = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
      const d = Math.hypot(ax + u * dx, ay + u * dy);
      if (d < best) { best = d; name = rd.name; }
    }
    return { name, d: best };
  }
  function nearestPlace(lon, lat) {
    let best = Infinity, name;
    for (const p of places) { const d = dToM(lon, lat, p.lon, p.lat); if (d < best) { best = d; name = p.name; } }
    return { name, d: best };
  }

  const depressions = deps.map((d) => {
    let area = 0, vol = 0, maxD = 0, sx = 0, sy = 0, sw = 0;
    const lakeHits = new Map();
    for (const i of d.cells) {
      const dd = depressionDepth[i];
      area += G.cellArea; vol += dd * G.cellArea; if (dd > maxD) maxD = dd;
      const r = (i / W) | 0, c = i % W;
      sx += G.lon(c) * dd; sy += G.lat(r) * dd; sw += dd;
      if (lakeName.has(i)) lakeHits.set(lakeName.get(i), (lakeHits.get(lakeName.get(i)) || 0) + 1);
    }
    const lon = sx / sw, lat = sy / sw;
    let lbl;
    if (lakeHits.size) lbl = [...lakeHits.entries()].sort((a, b) => b[1] - a[1])[0][0];
    else {
      const rd = nearestRoad(lon, lat), pl = nearestPlace(lon, lat);
      if (rd.name && rd.d < 250) lbl = pl.name && pl.d < 1500 ? `${rd.name}, ${pl.name}` : rd.name;
      else if (pl.name) lbl = `near ${pl.name}`;
    }
    return {
      id: 0,
      centroid: [round6(lon), round6(lat)],
      areaM2: Math.round(area),
      maxDepthM: Math.round(maxD * 100) / 100,
      volumeM3: Math.round(vol),
      catchmentM2: Math.round(d.catch * G.cellArea),
      cells: d.cells.sort((a, b) => a - b),
      ...(lbl ? { label: lbl } : {}),
    };
  });
  depressions.sort((a, b) => b.volumeM3 - a.volumeM3);
  depressions.forEach((d, k) => (d.id = k + 1));

  // ------------------------------------------------ write grids.bin + meta
  const layerDefs = [
    ['elevation', Float32Array.from(elevation), 'f32'],
    ['filled', Float32Array.from(filled), 'f32'],
    ['depressionDepth', depressionDepth, 'f32'],
    ['flowAccum', Float32Array.from(flowAccum), 'f32'],
    ['flowDir', flowDir, 'u8'],
    ['hand', hand, 'f32'],
    ['impervious', impervious, 'f32'],
    ['drainMask', drainMask, 'u8'],
    ['lakeMask', lakeMask, 'u8'],
    ['boundaryMask', boundaryMask, 'u8'],
  ];
  const layers = {};
  const chunks = [];
  let off = 0;
  for (const [name, arr, dtype] of layerDefs) {
    const bytes = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    layers[name] = { offset: off, length: arr.length, dtype };
    chunks.push(bytes);
    off += bytes.length;
    const pad = (4 - (off % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); off += pad; }
  }
  fs.writeFileSync(path.join(OUT, 'grids.bin'), Buffer.concat(chunks));

  let minE = Infinity, maxE = -Infinity, minB = Infinity, maxB = -Infinity, impSum = 0, nB = 0;
  for (let i = 0; i < N; i++) {
    minE = Math.min(minE, elevation[i]); maxE = Math.max(maxE, elevation[i]);
    if (boundaryMask[i]) { nB++; impSum += impervious[i]; minB = Math.min(minB, elevation[i]); maxB = Math.max(maxB, elevation[i]); }
  }
  const meta = {
    pincode: PINCODE,
    name: 'Rajarajeshwari Nagar',
    bbox: [G.w, G.s, G.e, G.n].map((v) => Math.round(v * 1e7) / 1e7),
    width: W,
    height: H,
    cellSizeM: CELL_M,
    boundary,
    layers,
    stats: { minElev: Math.round(minE * 100) / 100, maxElev: Math.round(maxE * 100) / 100 },
    sources,
  };
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(OUT, 'osm.geojson'), JSON.stringify({ type: 'FeatureCollection', features: outFeatures }));
  fs.writeFileSync(path.join(OUT, 'depressions.json'), JSON.stringify(depressions));

  // ------------------------------------------------ report
  const sz = (f) => (fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(2) + ' MB';
  log('---------------- summary ----------------');
  log(`DEM source: ${demName}`);
  log(`grid ${W}x${H} (${N} cells), cell ${CELL_M} m, boundary cells ${nB} (${((nB * G.cellArea) / 1e6).toFixed(2)} km2)`);
  log(`elevation whole grid ${minE.toFixed(1)}..${maxE.toFixed(1)} m; inside boundary ${minB.toFixed(1)}..${maxB.toFixed(1)} m`);
  log('feature counts', JSON.stringify(counts));
  log(`drain cells ${drainMask.reduce((a, b) => a + b, 0)}, lake cells ${lakeMask.reduce((a, b) => a + b, 0)}`);
  log(`impervious mean inside boundary: ${((impSum / nB) * 100).toFixed(1)}%`);
  log(`HAND drainage threshold: ${ACC_THRESH} cells; max flowAccum ${flowAccum.reduce((a, b) => Math.max(a, b), 0)}`);
  log(`depressions (>${MIN_DEPTH} m, >=${MIN_CELLS} cells): ${depressions.length}, total volume ${depressions.reduce((s, d) => s + d.volumeM3, 0)} m3`);
  for (const d of depressions.slice(0, 10)) {
    log(`  #${d.id} vol ${d.volumeM3} m3, area ${d.areaM2} m2, max ${d.maxDepthM} m, catch ${(d.catchmentM2 / 1e4).toFixed(1)} ha @ ${d.centroid.join(',')}  ${d.label ?? ''}`);
  }
  log(`files: meta.json ${sz('meta.json')}, grids.bin ${sz('grids.bin')}, osm.geojson ${sz('osm.geojson')}, depressions.json ${sz('depressions.json')}`);
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
