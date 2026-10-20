#!/usr/bin/env node
// City overview for Bengaluru Urban: pincode index, district outline, simplified pincode polygons
// and a precomputed flood-susceptibility index per pincode (district-wide terrain + hydrology at 60 m).
//
//   npm run data:city                 full build (needs .cache/osm/blr-region.osm.pbf + osmium-tool)
//   npm run data:city -- --index-only refresh public/data/pins/index.json from built packs' pack.json
//   ... --only-committed              list only packs git tracks (use before committing index.json;
//                                     a hosted copy built by data:all lists every built pack)
//   npm run data:city -- --flow-only  only the district routing for the packs' upstream inflow
//                                     (.cache/city/flow60.*); leaves the committed outputs alone
//
// Writes
//   public/data/pins/index.json    PinIndex (src/types.ts): every pincode kept, with its pack if built
//   public/data/city/city.geojson  district outline + pincode polygons (code, name, susceptibility)
//   .cache/pins/catalog.json       the same entries before pack info is merged (input to build-data)
//   .cache/city/flow60.{json,bin}  district D8 routing (scripts/lib/catchment.mjs): build-data turns it
//                                  into each pack's upstream inflow points (meta.inflow, M4)
//
// Pincode rule: OSM boundary=postal_code relations with a 6-digit code (postal_code tag, else name)
// whose area is at least 50 % inside the Bengaluru Urban district relation (2020589).
//
// Susceptibility index (0..1, documented in README "Susceptibility index"): a weighted mean of the
// pincode's percentile rank among all kept pincodes on four terrain/hydrology measures:
//   0.35 low ground    share of area with HAND < 2 m (height above the nearest drainage line)
//   0.25 ponding       depression-storage volume per km² (priority-flood fill depth x area)
//   0.20 sealed        mean impervious share (OSM buildings, roads, landuse)
//   0.20 inflow        upstream area draining in from outside the pincode, relative to its own area
// It ranks pincodes against each other; it is not a probability and not calibrated to events.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as turf from '@turf/turf';
import { REGION_PBF, hasOsmium } from './lib/osm-local.mjs';
import { accumulate, d8, downstream, fillGeom, gaussian, lineCells, linesOf, priorityFlood } from './lib/hydro.mjs';
import { outsideInflow, writeFlowGrids } from './lib/catchment.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const CITY_CACHE = path.join(CACHE, 'city');
const PINS_OUT = path.join(ROOT, 'public', 'data', 'pins');
const CITY_OUT = path.join(ROOT, 'public', 'data', 'city');
const DISTRICT_REL = 2020589;
const MIN_SHARE = 0.5;
const CELL_M = 60;
const PACK_PAD_DEG = 0.006; // same padding as build-data.mjs
const HAND_LOW_M = 2;
const DRAIN_KM2 = 0.5; // flow accumulation that counts as a drainage line for HAND
const UA = 'logged-flood-explorer/0.2 (open-source research prototype; github.com/achyuta0001/Logged)';
const W8 = { hand: 0.35, ponding: 0.25, sealed: 0.2, inflow: 0.2 };
const log = (...a) => console.log('[city]', ...a);

fs.mkdirSync(CITY_CACHE, { recursive: true });
fs.mkdirSync(PINS_OUT, { recursive: true });
fs.mkdirSync(CITY_OUT, { recursive: true });

// ------------------------------------------------------------------ osmium helpers
const osmium = (args) => execFileSync('osmium', args, { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'inherit'] });

/** stream `osmium export` GeoJSONSeq features of a filtered region file */
async function* exportSeq(filters, name, geomTypes = 'point,linestring,polygon') {
  const src = path.join(ROOT, REGION_PBF);
  const filtered = path.join(CITY_CACHE, `${name}.osm.pbf`);
  if (!fs.existsSync(filtered) || process.env.REFRESH) osmium(['tags-filter', src, ...filters, '-o', filtered, '--overwrite']);
  const p = spawn('osmium', ['export', filtered, '-f', 'geojsonseq', '-a', 'type,id', '--geometry-types', geomTypes, '-x', 'print_record_separator=false', '-o', '-']);
  p.stderr.on('data', () => {});
  const rl = readline.createInterface({ input: p.stdout, crlfDelay: Infinity });
  for await (const line of rl) if (line) yield JSON.parse(line);
}

// ------------------------------------------------------------------ boundaries
async function loadBoundaries() {
  const pins = new Map();
  let district = null;
  for await (const f of exportSeq(['r/boundary=postal_code,administrative'], 'boundaries', 'polygon')) {
    const t = f.properties;
    if (t['@type'] !== 'relation') continue;
    if (t['@id'] === DISTRICT_REL) district = f;
    if (t.boundary !== 'postal_code') continue;
    // postal_code tag, else a 6-digit code in ref or name ("Rajarajeshwarinagar - 560098")
    const code = [t.postal_code, t.ref, t.name].map((v) => String(v ?? '').match(/(?:^|\D)(\d{6})(?:\D|$)/)?.[1]).find(Boolean);
    if (!code || !code.startsWith('56')) continue;
    const area = turf.area(f);
    const prev = pins.get(code);
    // the same code on two relations: keep the larger (documented in the index rule)
    if (!prev || prev.area < area) pins.set(code, { code, relation: t['@id'], tags: t, geometry: f.geometry, area });
  }
  if (!district) throw new Error(`district relation ${DISTRICT_REL} not found in ${REGION_PBF}`);
  return { district, pins: [...pins.values()] };
}

const PLACE_RANK = { suburb: 0, quarter: 1, neighbourhood: 2, town: 0, village: 1, hamlet: 3, locality: 3, isolated_dwelling: 5 };
async function loadPlaces() {
  const out = [];
  for await (const f of exportSeq(['n/place=suburb,quarter,neighbourhood,town,village,hamlet,locality'], 'places', 'point')) {
    const t = f.properties;
    const name = t['name:en'] || t.name;
    if (!name || /^\d+$/.test(name)) continue;
    out.push({ name, rank: PLACE_RANK[t.place] ?? 4, coord: f.geometry.coordinates });
  }
  return out;
}

// ------------------------------------------------------------------ 60 m district grid
function makeGrid([w, s, e, n]) {
  const lat0 = (s + n) / 2;
  const dLat = CELL_M / 110574, dLon = CELL_M / (111320 * Math.cos((lat0 * Math.PI) / 180));
  const width = Math.ceil((e - w) / dLon), height = Math.ceil((n - s) / dLat);
  e = w + width * dLon;
  s = n - height * dLat;
  return {
    w, s, e, n, width, height, dLat, dLon, cellArea: CELL_M * CELL_M,
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

/** Copernicus GLO-30 block-mean onto the 60 m grid (DSM; bare-earth handled by a rank filter below) */
async function demGrid(G) {
  const cacheFile = path.join(CITY_CACHE, `dem60_${G.width}x${G.height}_${G.w.toFixed(3)}_${G.n.toFixed(3)}.bin`);
  if (fs.existsSync(cacheFile)) return new Float64Array(new Float32Array(fs.readFileSync(cacheFile).buffer.slice(0)));
  const { fromUrl } = await import('geotiff');
  const sum = new Float64Array(G.width * G.height), cnt = new Float64Array(G.width * G.height);
  for (let lat = Math.floor(G.s); lat <= Math.floor(G.n); lat++)
    for (let lon = Math.floor(G.w); lon <= Math.floor(G.e); lon++) {
      const name = `Copernicus_DSM_COG_10_N${String(lat).padStart(2, '0')}_00_E${String(lon).padStart(3, '0')}_00_DEM`;
      log(`Copernicus ${name} window read ...`);
      const tiff = await fromUrl(`https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`, { headers: { 'User-Agent': UA } });
      const img = await tiff.getImage();
      const [ox, oy] = img.getOrigin();
      const [rx, ry] = img.getResolution();
      const cx = (x) => Math.max(0, Math.min(img.getWidth(), x)), cy = (y) => Math.max(0, Math.min(img.getHeight(), y));
      const x0 = cx(Math.floor((G.w - ox) / rx)), x1 = cx(Math.ceil((G.e - ox) / rx));
      const y0 = cy(Math.floor((G.n - oy) / ry)), y1 = cy(Math.ceil((G.s - oy) / ry));
      if (x1 <= x0 || y1 <= y0) continue;
      const [band] = await img.readRasters({ window: [x0, y0, x1, y1] });
      const bw = x1 - x0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = G.cellOf(ox + (x + 0.5) * rx, oy + (y + 0.5) * ry);
          if (i < 0) continue;
          sum[i] += band[(y - y0) * bw + (x - x0)];
          cnt[i]++;
        }
    }
  const dem = new Float64Array(sum.length);
  for (let i = 0; i < dem.length; i++) dem[i] = cnt[i] ? sum[i] / cnt[i] : NaN;
  // fill any gaps (none expected) from neighbours
  for (let pass = 0; pass < 4; pass++)
    for (let i = 0; i < dem.length; i++)
      if (Number.isNaN(dem[i])) {
        const r = (i / G.width) | 0, c = i % G.width;
        let s = 0, n = 0;
        for (const [dr, dc] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && cc >= 0 && rr < G.height && cc < G.width && !Number.isNaN(dem[rr * G.width + cc])) { s += dem[rr * G.width + cc]; n++; }
        }
        if (n) dem[i] = s / n;
      }
  fs.writeFileSync(cacheFile, Buffer.from(Float32Array.from(dem).buffer));
  return dem;
}

/** 3x3 low-percentile filter: at 60 m a building or tree canopy rarely fills a whole 180 m window */
function lowFilter(src, W, H) {
  const out = new Float64Array(src.length), v = [];
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      v.length = 0;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && cc >= 0 && rr < H && cc < W) v.push(src[rr * W + cc]);
        }
      v.sort((a, b) => a - b);
      out[r * W + c] = Math.min(src[r * W + c], v[Math.floor(v.length * 0.25)]);
    }
  return out;
}

// ------------------------------------------------------------------ OSM cover (district-wide)
const IMPERV_LANDUSE = { residential: 0.6, commercial: 0.85, retail: 0.85, industrial: 0.85, railway: 0.6, construction: 0.5, garages: 0.9, education: 0.5, institutional: 0.6 };
const PERVIOUS = /^(grass|meadow|forest|farmland|orchard|recreation_ground|village_green|cemetery|greenfield|plant_nursery|allotments)$/;
async function coverGrids(G) {
  const N = G.width * G.height;
  const bld = new Float64Array(N), road = new Float64Array(N), base = new Float64Array(N).fill(0.35), drain = new Uint8Array(N), lake = new Uint8Array(N);
  let nb = 0;
  for await (const f of exportSeq(['nwr/building', 'w/highway', 'nwr/landuse', 'nwr/natural=water,wetland', 'nwr/water', 'nwr/waterway', 'nwr/leisure=park,garden'], 'cover')) {
    const t = f.properties, g = f.geometry;
    if (!g) continue;
    if (t.building && /Polygon/.test(g.type)) {
      const c = turf.centroid(f).geometry.coordinates, i = G.cellOf(c[0], c[1]);
      if (i >= 0) bld[i] += turf.area(f);
      nb++;
    } else if (t.highway && /LineString/.test(g.type)) {
      const wM = { motorway: 22, trunk: 20, primary: 14, secondary: 11, tertiary: 8 }[String(t.highway).replace('_link', '')] ?? 5;
      for (const ln of linesOf(g))
        for (let k = 0; k + 1 < ln.length; k++) {
          const a = ln[k], b = ln[k + 1], m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], i = G.cellOf(m[0], m[1]);
          if (i >= 0) road[i] += turf.distance(a, b, { units: 'meters' }) * wM;
        }
    } else if ((t.natural === 'water' || t.water || t.natural === 'wetland') && /Polygon/.test(g.type)) {
      fillGeom(G, g, 1, (i) => (lake[i] = 1));
    } else if (t.waterway && /LineString/.test(g.type) && /^(river|canal|stream|drain|ditch)$/.test(t.waterway)) {
      for (const ln of linesOf(g)) for (const i of lineCells(G, ln, 0.5)) drain[i] = 1;
    } else if (/Polygon/.test(g.type) && (t.landuse || t.leisure)) {
      const v = PERVIOUS.test(t.landuse ?? '') || t.leisure ? 0.1 : IMPERV_LANDUSE[t.landuse];
      if (v !== undefined) fillGeom(G, g, 1, (i) => (base[i] = Math.max(v === 0.1 ? 0 : base[i], v)));
    }
  }
  log(`cover: ${nb} buildings`);
  const imp = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const fb = Math.min(1, bld[i] / G.cellArea), fr = Math.min(1 - fb, road[i] / G.cellArea);
    imp[i] = lake[i] ? 0 : Math.min(1, fb * 0.95 + fr * 0.9 + (1 - fb - fr) * base[i]);
  }
  return { imp, drain, lake };
}

// ------------------------------------------------------------------ main
function rankPct(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  idx.forEach(([, i], k) => (out[i] = values.length > 1 ? k / (values.length - 1) : 0.5));
  // ties share the mean rank
  for (let k = 0; k < idx.length; ) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[k][0]) j++;
    const m = (out[idx[k][1]] + out[idx[j][1]]) / 2;
    for (let q = k; q <= j; q++) out[idx[q][1]] = m;
    k = j + 1;
  }
  return out;
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** merge built packs (pack.json) into the catalog and write public/data/pins/index.json */
const ONLY_COMMITTED = process.argv.includes('--only-committed');
const FLOW_ONLY = process.argv.includes('--flow-only');

/** M4 numbers a pack's meta.json carries (build-data.mjs): total upstream area outside its grid, and how much of it is simulated */
function packInflowInfo(dir, hydro) {
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    /* no meta: fall back to the district value */
  }
  const total = meta.upstreamOutsideKm2 ?? hydro?.upstreamOutsideKm2;
  const sim = Array.isArray(meta.inflow) ? round(meta.inflow.reduce((s, p) => s + (p.areaKm2 || 0), 0), 2) : undefined;
  return { ...(total !== undefined ? { upstreamOutsideKm2: total } : {}), ...(sim !== undefined ? { inflowKm2: sim } : {}) };
}
function gitIgnored(dir) {
  try {
    execFileSync('git', ['check-ignore', '-q', path.join(dir, 'pack.json')], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function writeIndex(catalog) {
  const pins = catalog.pins.map((p) => {
    const e = { ...p };
    delete e.hydro;
    // every pack, the 560098 reference pack included, lives in public/data/pins/<code>/
    const dir = path.join(PINS_OUT, p.code);
    const pj = path.join(dir, 'pack.json');
    if (fs.existsSync(pj) && !(ONLY_COMMITTED && gitIgnored(dir))) {
      const k = JSON.parse(fs.readFileSync(pj, 'utf8'));
      e.pack = { path: p.code, format: k.format, bytes: k.bytes, gzipBytes: k.gzipBytes, built: k.built, sources: k.sources, ...packInflowInfo(dir, p.hydro) };
    }
    return e;
  });
  const index = { version: 1, generated: catalog.generated, district: catalog.district, rule: catalog.rule, pins };
  fs.writeFileSync(path.join(PINS_OUT, 'index.json'), JSON.stringify(index));
  log(`index.json: ${pins.length} pincodes, ${pins.filter((p) => p.pack).length} with packs`);
}

async function main() {
  const catalogFile = path.join(CACHE, 'pins', 'catalog.json');
  if (process.argv.includes('--index-only')) {
    if (fs.existsSync(catalogFile)) return writeIndex(JSON.parse(fs.readFileSync(catalogFile, 'utf8')));
    // no catalog (e.g. a checkout that only ran --flow-only): the committed index is the catalog
    const idxFile = path.join(PINS_OUT, 'index.json');
    if (!fs.existsSync(idxFile)) throw new Error('no .cache/pins/catalog.json or index.json yet: run npm run data:city first');
    const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
    log('no catalog: refreshing the packs listed in the existing index.json');
    return writeIndex({ ...idx, pins: idx.pins.map(({ pack, ...p }) => ({ ...p, hydro: pack?.upstreamOutsideKm2 !== undefined ? { upstreamOutsideKm2: pack.upstreamOutsideKm2 } : undefined })) });
  }
  if (!fs.existsSync(path.join(ROOT, REGION_PBF)) || !hasOsmium()) throw new Error(`needs ${REGION_PBF} (scripts/osm-extract.sh) and osmium-tool`);
  const t0 = Date.now();
  const { district, pins: raw } = await loadBoundaries();
  const dGeom = turf.simplify(district, { tolerance: 0.0003, highQuality: true });
  log(`district ${district.properties.name}: ${(turf.area(district) / 1e6).toFixed(0)} km²; ${raw.length} postal_code relations with 56xxxx codes`);

  const kept = [];
  for (const p of raw) {
    const f = turf.feature(p.geometry);
    let inside = 0;
    try {
      const x = turf.intersect(turf.featureCollection([f, dGeom]));
      inside = x ? turf.area(x) : 0;
    } catch (e) {
      log(`  ${p.code}: intersect failed (${e.message}); using centroid test`);
      inside = turf.booleanPointInPolygon(turf.centroid(f), dGeom) ? p.area : 0;
    }
    p.share = Math.min(1, inside / p.area);
    if (p.share >= MIN_SHARE) kept.push(p);
    else log(`  skip ${p.code} (${(p.share * 100).toFixed(0)} % inside)`);
  }
  log(`kept ${kept.length} pincodes (>= ${MIN_SHARE * 100} % inside the district)`);

  const places = await loadPlaces();
  for (const p of kept) {
    const f = turf.feature(p.geometry);
    const inside = places.filter((q) => turf.booleanPointInPolygon(q.coord, f)).sort((a, b) => a.rank - b.rank);
    const names = [...new Set(inside.map((q) => q.name))];
    // "Rajarajeshwarinagar - 560098" -> "Rajarajeshwarinagar"
    const own = [p.tags['name:en'], p.tags.name]
      .map((v) => String(v ?? '').replace(p.code, '').replace(/^[\s\-–,:]+|[\s\-–,:(]+$/g, '').replace(/\(\s*\)/g, '').trim())
      .find((v) => v && !/^\d+$/.test(v) && !/postal|pin ?code/i.test(v));
    p.name = own ?? names[0] ?? `Pincode ${p.code}`;
    p.localities = names.filter((n) => n !== p.name).slice(0, 15);
    p.bbox = turf.bbox(f).map(r6);
    p.centroid = turf.centroid(f).geometry.coordinates.map(r6);
  }

  // -------------------------------- district terrain + hydrology
  const db = turf.bbox(district);
  const G = makeGrid([db[0] - 0.04, db[1] - 0.04, db[2] + 0.04, db[3] + 0.04]);
  const N = G.width * G.height;
  log(`grid ${G.width} x ${G.height} @ ${CELL_M} m`);
  const dsm = await demGrid(G);
  const { imp, drain, lake } = await coverGrids(G);
  const dem = gaussian(lowFilter(dsm, G.width, G.height), G.width, G.height, 1);
  for (let i = 0; i < N; i++) dem[i] -= (drain[i] ? 2 : 0) + (lake[i] ? 0.5 : 0);
  const filled = priorityFlood(dem, G.width, G.height, 1e-3);
  const dir = d8(filled, G.width, G.height, CELL_M);
  const acc = accumulate(dir, G.width, G.height);
  // the packs' upstream inflow (build-data.mjs) starts from this routing
  const flow = { G, dir, acc, dem, imp, lake, drain };
  writeFlowGrids(ROOT, G, flow);
  log(`flow grids: .cache/city/flow60.{json,bin} (${G.width} x ${G.height})`);
  if (FLOW_ONLY) return log(`--flow-only: done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const thresh = (DRAIN_KM2 * 1e6) / G.cellArea;
  const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => filled[a] - filled[b]);
  const target = new Int32Array(N).fill(-1);
  for (const i of order) {
    if (acc[i] >= thresh || drain[i] || lake[i]) { target[i] = i; continue; }
    const j = downstream(i, dir[i], G.width);
    target[i] = j >= 0 && target[j] >= 0 ? target[j] : i;
  }

  // per pincode measures
  const pinOf = new Int32Array(N).fill(-1);
  kept.forEach((p, k) => fillGeom(G, p.geometry, 1, (i) => (pinOf[i] = k)));
  const m = kept.map(() => ({ n: 0, low: 0, vol: 0, imp: 0, inflow: 0 }));
  for (let i = 0; i < N; i++) {
    const k = pinOf[i];
    if (k >= 0) {
      const x = m[k];
      x.n++;
      if (dem[i] - dem[target[i]] < HAND_LOW_M) x.low++;
      x.vol += (filled[i] - dem[i]) * G.cellArea;
      x.imp += imp[i];
    }
    // inflow: a cell outside pincode k draining straight into it carries its whole upstream area
    const j = downstream(i, dir[i], G.width);
    if (j >= 0 && pinOf[j] >= 0 && pinOf[j] !== k) m[pinOf[j]].inflow += acc[i] * G.cellArea;
  }
  // upstream area entering each pack's padded bbox from outside it (M4); only outside cells count, as in
  // the packs' simulated inflow (build-data.mjs writes the exact value for its grid into meta.json)
  for (const p of kept) {
    const bb = [p.bbox[0] - PACK_PAD_DEG, p.bbox[1] - PACK_PAD_DEG, p.bbox[2] + PACK_PAD_DEG, p.bbox[3] + PACK_PAD_DEG];
    p.upstreamOutsideKm2 = round(outsideInflow(flow, bb).totalKm2, 2);
  }
  const low = m.map((x) => (x.n ? x.low / x.n : 0));
  const pond = m.map((x, k) => x.vol / (kept[k].area / 1e6));
  const seal = m.map((x) => (x.n ? x.imp / x.n : 0));
  const infl = m.map((x, k) => x.inflow / kept[k].area);
  const [rl, rp, rs, ri] = [low, pond, seal, infl].map(rankPct);
  kept.forEach((p, k) => {
    p.susceptibility = round(W8.hand * rl[k] + W8.ponding * rp[k] + W8.sealed * rs[k] + W8.inflow * ri[k]);
    p.hydro = { handLowShare: round(low[k]), pondingM3PerKm2: Math.round(pond[k]), impervious: round(seal[k]), inflowKm2: round(m[k].inflow / 1e6, 2), upstreamOutsideKm2: p.upstreamOutsideKm2 };
  });

  // -------------------------------- outputs
  const generated = new Date().toISOString().slice(0, 10);
  const info = path.join(CACHE, 'osm', 'blr-region.json');
  const osmDate = fs.existsSync(info) ? JSON.parse(fs.readFileSync(info, 'utf8')).built.slice(0, 10) : generated;
  const catalog = {
    version: 1,
    generated,
    district: { relation: DISTRICT_REL, name: 'Bengaluru Urban' },
    rule: `OSM boundary=postal_code relations with a 6-digit 56xxxx code (postal_code, else ref/name), at least ${MIN_SHARE * 100} % of whose area lies inside OSM relation ${DISTRICT_REL}; duplicates keep the larger relation. OSM extract ${osmDate}.`,
    pins: kept
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((p) => ({
        code: p.code,
        name: p.name,
        ...(p.localities.length ? { localities: p.localities } : {}),
        relation: p.relation,
        bbox: p.bbox,
        centroid: p.centroid,
        areaKm2: round(p.area / 1e6, 2),
        districtShare: round(p.share),
        susceptibility: p.susceptibility,
        hydro: p.hydro,
      })),
  };
  fs.mkdirSync(path.dirname(catalogFile), { recursive: true });
  fs.writeFileSync(catalogFile, JSON.stringify(catalog, null, 1));
  writeIndex(catalog);

  const feats = [
    { type: 'Feature', properties: { kind: 'district', name: 'Bengaluru Urban', relation: DISTRICT_REL }, geometry: roundGeom(turf.simplify(district, { tolerance: 0.0006, highQuality: true }).geometry) },
    ...kept.map((p) => ({
      type: 'Feature',
      properties: { kind: 'pin', code: p.code, name: p.name, s: p.susceptibility },
      geometry: roundGeom(turf.simplify(turf.feature(p.geometry), { tolerance: 0.0002, highQuality: true }).geometry),
    })),
  ];
  fs.writeFileSync(
    path.join(CITY_OUT, 'city.geojson'),
    JSON.stringify({
      type: 'FeatureCollection',
      attribution: '© OpenStreetMap contributors (ODbL); susceptibility from Copernicus DEM GLO-30 and OSM',
      generated,
      weights: W8,
      features: feats,
    }),
  );
  log(`city.geojson ${(fs.statSync(path.join(CITY_OUT, 'city.geojson')).size / 1e3).toFixed(0)} kB; done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  for (const p of [...catalog.pins].sort((a, b) => b.susceptibility - a.susceptibility).slice(0, 12))
    log(`  ${p.code} ${p.name.padEnd(28)} s=${p.susceptibility} low=${p.hydro.handLowShare} pond=${p.hydro.pondingM3PerKm2} imp=${p.hydro.impervious} inflow=${p.hydro.inflowKm2} km²`);
}

function roundGeom(g) {
  const rc = (c) => (typeof c[0] === 'number' ? [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5] : c.map(rc));
  return { type: g.type, coordinates: rc(g.coordinates) };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
