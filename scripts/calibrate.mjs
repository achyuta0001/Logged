#!/usr/bin/env node
// Calibration harness for the flood model (no site-specific tuning happens here — it only measures).
//
// Runs FloodEngine inline on public/data for the reference scenarios and prints, per scenario:
//   - max modelled depth within 150 m (and 60 m) of every reported hotspot (running max over the run)
//   - flooded area (> 0.1 m, inside the pincode boundary) at the peak hour
//   - hours after the rain stops until the flooded area is back below 25 % of its peak
//   - peak / final surface volume and the water budget (closure error should be ~0)
//
//   node scripts/calibrate.mjs                                   current data + src/sim
//   node scripts/calibrate.mjs --save .cache/calib-before.json   also store the results
//   node scripts/calibrate.mjs --baseline .cache/calib-before.json   print BEFORE vs AFTER
//   node scripts/calibrate.mjs --data <dir> --sim <dir>          other data / engine (e.g. a git worktree)
//   node scripts/calibrate.mjs --perf                            also time a 216-hour forecast-like run
//   node scripts/calibrate.mjs --scenario cloudburst             add/override scenarios (comma list)
//   node scripts/calibrate.mjs --pin 560034                      another pincode's pack (public/data/pins/<code>)
//   node scripts/calibrate.mjs --pin 560034 --impact             also buildings wet / roads closed at the peak
//   node scripts/calibrate.mjs --pin 560034 --no-inflow          ignore the pack's upstream inflow points (M4)
//   node scripts/calibrate.mjs --pin 560034 --event all          also the real storms (HISTORICAL_EVENTS in src/weather.ts,
//                                                                comma list of ids or "all"): hourly rain fetched from the
//                                                                Open-Meteo archive (free, keyless, CC BY 4.0) at the pin centroid.
//                                                                Each storm also has a scaled twin, <id>-gauge (e.g. real-2022-09-05-gauge):
//                                                                the same archive hours scaled to the reported gauge total ("all" runs both)
//
// Requires Node >= 22.6 (native TypeScript type stripping) — the engine and the scenario series are
// imported straight from src/sim/index.ts and src/weather.ts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPackJson } from './lib/pack-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const k = args.indexOf(`--${name}`);
  return k >= 0 && k + 1 < args.length && !args[k + 1].startsWith('--') ? args[k + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const PIN = opt('pin', '');
const PACK_DIR = PIN && PIN !== '560098' ? `public/data/pins/${PIN}` : 'public/data';
const DATA = path.resolve(ROOT, opt('data', PACK_DIR));
const SIM = path.resolve(ROOT, opt('sim', 'src/sim'));
const HOTSPOTS = path.resolve(ROOT, opt('hotspots', path.join(path.relative(ROOT, DATA), 'hotspots.json')));
const SCEN_IDS = opt('scenario', 'rrnagar-2024-10-20,typical-evening').split(',');
const RADII = [150, 300];

// ---------------------------------------------------------------- load
const { terrainFromBuffer } = await import(pathToFileURL(path.join(ROOT, 'src/terrain.ts')).href);
function loadTerrain(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const buf = fs.readFileSync(path.join(dir, 'grids.bin'));
  // copies every layer (v1 views over one buffer would share it with the engine's transfers)
  const t = terrainFromBuffer(meta, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  for (const k of Object.keys(t.grids)) t.grids[k] = t.grids[k].slice();
  return t;
}

const terrain = loadTerrain(DATA);
// M4: upstream inflow points (meta.inflow) are simulated unless --no-inflow
const INFLOW_PTS = terrain.meta.inflow?.length ?? 0;
if (flag('no-inflow')) delete terrain.meta.inflow;
// packs without sourced reports have no hotspots.json: the hotspot table is then empty
const hotspots = fs.existsSync(HOTSPOTS) ? JSON.parse(fs.readFileSync(HOTSPOTS, 'utf8')) : [];
const IMPACT = flag('impact');
let osm = null;
let computeImpact = null;
if (IMPACT) {
  osm = readPackJson(DATA, 'osm.geojson'); // osm.geojson.gz in format-2 packs
  if (!osm) throw new Error(`no osm.geojson(.gz) in ${DATA}`);
  if ((terrain.meta.format ?? 1) >= 2) (await import(pathToFileURL(path.join(ROOT, 'src/pack/osm.ts')).href)).deriveOsmCells(osm, terrain.meta);
  ({ computeImpact } = await import(pathToFileURL(path.join(ROOT, 'src/impact.ts')).href));
}
const { FloodEngine } = await import(pathToFileURL(path.join(SIM, 'index.ts')).href);
const { SCENARIOS, HISTORICAL_EVENTS, fetchHistoricalEvent } = await import(pathToFileURL(path.join(ROOT, 'src/weather.ts')).href);

const { meta } = terrain;
const { width: W, height: H } = meta;
const [bw, bs, be, bn] = meta.bbox;
const cellLonLat = (i) => [bw + ((i % W) + 0.5) / W * (be - bw), bn - (Math.floor(i / W) + 0.5) / H * (bn - bs)];

/** grid cells whose centre lies within r metres of [lon, lat] */
function cellsWithin(lon, lat, r) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110574;
  const c0 = Math.floor(((lon - bw) / (be - bw)) * W), r0 = Math.floor(((bn - lat) / (bn - bs)) * H);
  const span = Math.ceil(r / meta.cellSizeM) + 1;
  const out = [];
  for (let rr = r0 - span; rr <= r0 + span; rr++)
    for (let cc = c0 - span; cc <= c0 + span; cc++) {
      if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
      const i = rr * W + cc;
      const [x, y] = cellLonLat(i);
      if (Math.hypot((x - lon) * kx, (y - lat) * ky) <= r) out.push(i);
    }
  return out;
}
const hotCells = hotspots.map((h) => Object.fromEntries(RADII.map((r) => [r, cellsWithin(h.coord[0], h.coord[1], r)])));

// ---------------------------------------------------------------- run
async function runScenario(series) {
  const eng = await FloodEngine.create(terrain, {}, { inline: true });
  const t0 = performance.now();
  await eng.run(series);
  const ms = performance.now() - t0;
  const st = eng.hourStats;
  const n = eng.hours;
  const last = eng.snapshot(n - 1);
  const mm = series.mm;
  let rainEnd = -1;
  mm.forEach((v, i) => { if (v > 0) rainEnd = i; });
  const peak = eng.peakHour();
  const peakArea = peak >= 0 ? st[peak].floodedAreaM2 : 0;
  let recessionH = null;
  if (peakArea > 0) {
    for (let k = Math.max(rainEnd, peak); k < n; k++) if (st[k].floodedAreaM2 < 0.25 * peakArea) { recessionH = k - rainEnd; break; }
  }
  const sum = (key) => st.reduce((s, x) => s + (x[key] || 0), 0);
  const budget = { rain: sum('rainM3'), inflow: sum('inflowM3'), infiltrated: sum('infiltratedM3'), drained: sum('drainedM3'), lake: sum('lakeM3'), outflow: sum('outflowM3') };
  const endVol = st[n - 1].volumeM3;
  const closure = (budget.rain + budget.inflow - budget.infiltrated - budget.drained - budget.lake - budget.outflow - endVol) / Math.max(1, budget.rain + budget.inflow);
  const hot = hotspots.map((h, k) => {
    const o = { name: h.name };
    for (const r of RADII) {
      const cells = hotCells[k][r];
      o[`max${r}`] = cells.length ? Math.max(...cells.map((i) => last.maxDepth[i])) : null;
    }
    // same, but ignoring water inside mapped drain channels and lakes (not street flooding)
    for (const r of RADII) {
      const street = hotCells[k][r].filter((i) => !terrain.grids.drainMask[i] && !terrain.grids.lakeMask[i]);
      o[`street${r}`] = street.length ? Math.max(...street.map((i) => last.maxDepth[i])) : null;
    }
    return o;
  });
  // tanks that filled their flood cushion and spilled (engine internals, inline runner only)
  const core = eng.inlineRunner?.core;
  const lakes = typeof core?.lakeStatus === 'function' ? core.lakeStatus().filter((l) => l.cells >= 2) : null;
  const lakeSpill = lakes ? `${lakes.filter((l) => l.freeM3 <= 1e-6).length}/${lakes.length}` : 'n/a';
  // daily-life impact at the peak hour (same computeImpact the app uses)
  let impact = null;
  if (IMPACT && peak >= 0) {
    const r = computeImpact(terrain, osm, eng.snapshot(peak));
    impact = { buildingsWet: r.buildings.groundFloorWet, buildings: r.buildings.total, roadClosedCarKm: r.roads.impassableCarKm, roadClosedTwoWheelerKm: r.roads.impassableTwoWheelerKm, roadKm: r.roads.totalKm, overall: r.overall };
  }
  return {
    label: series.label,
    impact,
    lakeSpill,
    ms: Math.round(ms),
    hours: n,
    rainMm: mm.reduce((a, b) => a + b, 0),
    peakMmHr: Math.max(0, ...mm),
    rainEnd,
    peakHour: peak,
    peakAreaM2: peakArea,
    endAreaM2: st[n - 1].floodedAreaM2,
    areaAtRainEndPlus: Object.fromEntries([0, 3, 6, 12].map((d) => [d, st[Math.min(n - 1, rainEnd + d)]?.floodedAreaM2 ?? 0])),
    recessionH,
    peakVolM3: Math.max(...st.map((s) => s.volumeM3)),
    endVolM3: endVol,
    maxDepthM: Math.max(...st.map((s) => s.maxDepthM)),
    budget,
    closure,
    hotspots: hot,
  };
}

const results = { pin: meta.pincode, name: meta.name, cellSizeM: meta.cellSizeM, cells: W * H, data: path.relative(ROOT, DATA) || '.', sim: path.relative(ROOT, SIM) || '.', scenarios: {} };
for (const id of SCEN_IDS) {
  const sc = SCENARIOS.find((s) => s.id === id);
  if (!sc) throw new Error(`unknown scenario ${id}`);
  results.scenarios[id] = await runScenario(sc.build());
}

// real storms: archive rain at the pin centroid (the point the app asks for), else the bbox centre
const EVENT_ARG = opt('event', '');
const EVENT_IDS = EVENT_ARG === 'all' ? HISTORICAL_EVENTS.map((e) => e.id) : EVENT_ARG ? EVENT_ARG.split(',') : [];
if (EVENT_IDS.length) {
  const idxFile = path.join(ROOT, 'public/data/pins/index.json');
  const entry = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, 'utf8')).pins?.find((p) => p.code === String(meta.pincode)) : null;
  const [lon, lat] = entry?.centroid ?? [(bw + be) / 2, (bs + bn) / 2];
  results.archivePoint = [lon, lat];
  for (const id of EVENT_IDS) {
    const ev = HISTORICAL_EVENTS.find((e) => e.id === id);
    if (!ev) throw new Error(`unknown event ${id} (known: ${HISTORICAL_EVENTS.map((e) => e.id).join(', ')}, all)`); // raw and -gauge ids
    results.scenarios[id] = await runScenario(await fetchHistoricalEvent(lat, lon, ev));
  }
}

if (flag('perf')) {
  // forecast-like 216 h series: nine wet monsoon afternoons (40 mm each, 6 h), the rest dry
  const mm = [];
  for (let d = 0; d < 9; d++) for (let h = 0; h < 24; h++) mm.push([3, 10, 15, 8, 3, 1][h - 14] ?? 0);
  const series = { source: 'forecast', label: 'perf', times: mm.map((_, i) => i * 3.6e6), mm };
  const eng = await FloodEngine.create(terrain, {}, { inline: true });
  await eng.run({ ...series, mm: mm.slice(0, 6) }); // warm-up (JIT)
  const t0 = performance.now();
  await eng.run(series);
  results.perf = { hours: mm.length, ms: Math.round(performance.now() - t0) };
}

// ---------------------------------------------------------------- report
const f2 = (v) => (v == null ? '   -  ' : v.toFixed(2).padStart(6));
const km2 = (m2) => (m2 / 1e6).toFixed(3);
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const base = opt('baseline') ? JSON.parse(fs.readFileSync(path.resolve(ROOT, opt('baseline')), 'utf8')) : null;

function printHotspots() {
  // primary metric: max depth within 150 m (running max over the run); diagnostics: the same without
  // water inside mapped drain channels / lakes ("street"), and within 300 m (hotspot coordinates are
  // neighbourhood-level geocodes of news reports)
  for (const id of Object.keys(results.scenarios)) {
    console.log(`\n${id}: max depth (m) near reported hotspots`);
    console.log(`${pad('hotspot', 46)} | ${base ? '150m BEFORE  AFTER | street150 BEFORE  AFTER | 300m BEFORE  AFTER | street300 BEFORE  AFTER' : '150m | street150 | 300m | street300'}`);
    hotspots.forEach((h, k) => {
      const a = results.scenarios[id].hotspots[k];
      const b = base?.scenarios?.[id]?.hotspots?.find((x) => x.name === h.name);
      const pair = (key, w) => (base ? `${' '.repeat(w)}${f2(b?.[key])} ${f2(a[key])}` : f2(a[key]));
      console.log(`${pad(h.name, 46)} | ${pair('max150', 4)} | ${pair('street150', 9)} | ${pair('max300', 4)} | ${pair('street300', 9)}`);
    });
  }
}

function summaryRows(r) {
  const b = r.budget;
  return [
    ['rain series', r.label ?? '-'],
    ['rain (mm)', r.rainMm.toFixed(1)],
    ['wettest hour (mm)', r.peakMmHr == null ? '-' : r.peakMmHr.toFixed(1)],
    ['peak flooded area >0.1 m (km2) @hour', `${km2(r.peakAreaM2)} @${r.peakHour}`],
    ['flooded area rain-end +0/+3/+6/+12 h (km2)', [0, 3, 6, 12].map((d) => km2(r.areaAtRainEndPlus[d])).join(' / ')],
    ['hours after rain to < 25% of peak area', r.recessionH == null ? `> ${r.hours - 1 - r.rainEnd}` : String(r.recessionH)],
    ['peak / final surface volume (m3)', `${Math.round(r.peakVolM3)} / ${Math.round(r.endVolM3)}`],
    ['max depth anywhere (m)', r.maxDepthM.toFixed(2)],
    ['tanks (>= 2 cells) spilled at end', r.lakeSpill ?? 'n/a'],
    ['budget rain / inflow / infil / drain / lake / out (k m3)', [b.rain, b.inflow ?? 0, b.infiltrated, b.drained, b.lake, b.outflow].map((v) => (v / 1000).toFixed(0)).join(' / ')],
    ['budget closure (rel.)', r.closure.toExponential(1)],
    ...(r.impact
      ? [
          ['buildings with water over plinth @peak', `${r.impact.buildingsWet} of ${r.impact.buildings}`],
          ['road closed to cars / two-wheelers @peak (km)', `${r.impact.roadClosedCarKm.toFixed(1)} / ${r.impact.roadClosedTwoWheelerKm.toFixed(1)} of ${r.impact.roadKm.toFixed(0)}`],
        ]
      : []),
    ['run time (ms)', String(r.ms)],
  ];
}

console.log(`data: ${results.data}   engine: ${results.sim}   grid ${W}x${H} @ ${meta.cellSizeM} m`);
console.log(`upstream inflow: ${meta.inflow?.length ? `${meta.inflow.length} points, ${meta.inflow.reduce((s, p) => s + p.areaKm2, 0).toFixed(1)} of ${meta.upstreamOutsideKm2 ?? '?'} km² simulated` : INFLOW_PTS ? `off (--no-inflow; the pack has ${INFLOW_PTS} points)` : 'none in this pack'}`);
if (results.archivePoint) console.log(`real storms: Open-Meteo archive (reanalysis, CC BY 4.0) at ${results.archivePoint.map((v) => v.toFixed(4)).join(', ')}`);
printHotspots();
for (const [id, r] of Object.entries(results.scenarios)) {
  const br = base?.scenarios?.[id];
  console.log(`\n${id}${br ? '                                     BEFORE  ->  AFTER' : ''}`);
  const rows = summaryRows(r);
  const brows = br ? summaryRows(br) : null;
  rows.forEach(([k, v], i) => console.log(`  ${pad(k, 46)} ${brows ? `${brows[i][1]}  ->  ${v}` : v}`));
}
if (results.perf) console.log(`\nperf: ${results.perf.hours}-hour series in ${results.perf.ms} ms${base?.perf ? ` (before ${base.perf.ms} ms)` : ''}`);

const save = opt('save');
if (save) {
  fs.mkdirSync(path.dirname(path.resolve(ROOT, save)), { recursive: true });
  fs.writeFileSync(path.resolve(ROOT, save), JSON.stringify(results, null, 1));
  console.log(`\nsaved ${save}`);
}
