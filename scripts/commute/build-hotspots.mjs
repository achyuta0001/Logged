#!/usr/bin/env node
// Commute hotspot registry: public/data/commute/hotspots.geojson, one Point feature per hotspot with
// the CommuteHotspot fields (src/commute/types.ts) as properties.
//
//   node scripts/commute/build-hotspots.mjs          (about 20 s; reproducible from the inputs below)
//
// Inputs
//   public/data/news-spots.json, public/data/hotspots-city.json   sourced flood reports (dates, links)
//   EXTRA below: reports found by web search on 2026-10-20, each read in the article itself and placed
//     on a named OSM object (never from memory)
//   .cache/osm/blr-region.osm.pbf (npm run data:osm) + osmium-tool: the highway ways at each hotspot
//   .cache/city/flow60.{json,bin} (npm run data:city): 60 m terrain and D8 routing, for HAND and relief
//   public/data/city/city.geojson: pincode susceptibility
//
// Steps
//   1. Merge the report lists into places: two entries are one place when they lie within 80 m, or
//      within 250 m with similar names, or have the same normalised name (before any comma) within
//      3 km, or cite the
//      same article with similar names within 5 km (one report geocoded twice).
//   2. Keep the places a commuter drives through: drop lakes, walls, apartment complexes, villas and
//      gated layouts (EXCLUDE); keep every underpass, junction, flyover, road, station and tech park;
//      keep a layout only when it was reported on 2+ days or lies within 100 m of a tertiary or
//      bigger road. EXTRA places are always kept. At most MAX_HOTSPOTS, the most reported first.
//   3. Type from the place name (underpass / flyover_ramp / junction / service_road / road / layout).
//   4. ways: OSM highway ways within 60 m whose name shares a word with the hotspot's; else, at a
//      junction every tertiary-or-bigger way within 60 m; else the nearest ways within 60 m. Underpasses
//      add tunnel ways within 120 m, flyovers bridge and link ways within 120 m.
//   5. lowness (0..1) = 0.5 x (1 - HAND / 6 m) + 0.3 x (relief / 3 m) + 0.2 x pincode susceptibility,
//      each part clamped to 0..1. HAND: height above the nearest drainage line (>= 0.5 km² catchment,
//      a mapped drain or a lake), lowest of the 3 x 3 cells around the spot. Relief: how far the spot
//      lies below the mean ground within 300 m. A 60 m surface model cannot see an underpass dip, so
//      underpasses get their low threshold from the type default, not from lowness.
//   6. reportDays: distinct flood events (dates within 2 days count once; a month-only date counts
//      when no full date falls in that month). sources: the 3 newest distinct articles.
// Extra properties beyond the contract: `dates` (every report date, newest first: the backtest uses
// them) and `low` (the lowness inputs, for the explain view).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { coreTokens, eventCount, kindOf, metres, nameSimilar, normName } from '../../src/commute/spots.ts';
import { pointInGeometry } from '../../src/commute/near.ts';
import { hotspotErrors } from '../../src/commute/registry.ts';
import { readFlowGrids } from '../lib/catchment.mjs';
import { downstream } from '../lib/hydro.mjs';
import { REGION_PBF, hasOsmium, unescapeOpl } from '../lib/osm-local.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = path.join(ROOT, '.cache', 'commute');
const OUT = path.join(ROOT, 'public', 'data', 'commute', 'hotspots.geojson');
const BBOX = [77.38, 12.73, 77.79, 13.18];
const MAX_HOTSPOTS = 100;
const MATCH_M = 60;
const STRUCT_M = 120;
const MAJOR_M = 100;
const log = (...a) => console.log('[hotspots]', ...a);

// ------------------------------------------------------------------ extra sourced reports
// Found by web search 2026-10-20; every sentence below was read in the article (Deccan Herald pages
// fetched that day). Dates are publication dates, like the rest of the data.
const DH = 'https://www.deccanherald.com/india/karnataka/bengaluru/';
const DH_2025_05_16 = `${DH}people-wade-vehicles-navigate-choked-roads-amid-continuous-downpour-3543044`; // Khoday Junction and Windsor Manor underpasses inundated; MG Road near Queens Circle; temporary lake at Sirur Park Junction near Mantri Square Mall
const DH_2024_10_21 = `${DH}bengaluru-rains-waterlogging-slow-moving-traffic-tree-falls-disrupt-normal-life-as-imd-issues-orange-alert-3241096`; // flooding at Nagavara Junction, Windsor Manor bridge, Millers Road underpass, Panathur underbridge; homes in Murphy Town, Halasuru flooded
const DH_2024_10_23 = `${DH}bengaluru-endures-another-day-of-rain-nightmare-3244256`; // Murphy Town and Sai Layout inundated again on Tuesday morning
const DH_2024_10_06 = `${DH}sudden-deluge-of-rains-trigger-traffic-jams-water-logging-in-bengaluru-3221194`; // waterlogging on Hosur Road between Chandapura Circle and Bommasandra; severe near Bommasandra Industrial Area
const EXTRA = [
  { name: 'Sirur Park Junction', type: 'junction', place: { junction: ['Sirur Park Road', 'Sampige Road'], near: [77.57076, 12.99153] }, reports: [['2025-05-16', DH_2025_05_16]] },
  { name: 'Panathur railway underpass', type: 'underpass', place: { way: 137321743 }, reports: [['2024-10-21', DH_2024_10_21]] },
  { name: 'Millers Road underpass', type: 'underpass', place: { way: 143364234 }, reports: [['2024-10-21', DH_2024_10_21]] },
  { name: 'Nagavara Junction, Outer Ring Road', type: 'junction', place: { node: 1789912200 }, reports: [['2024-10-21', DH_2024_10_21]] },
  { name: 'Murphy Town, Halasuru', type: 'layout', place: { node: 5726430822 }, reports: [['2024-10-21', DH_2024_10_21], ['2024-10-23', DH_2024_10_23]] },
  { name: 'Hosur Road at Bommasandra', type: 'road', place: { node: 2625813360 }, reports: [['2024-10-06', DH_2024_10_06]] },
];
/** the same articles name places we already have: add the report to the nearest place of that name */
const EXTRA_AT = [
  ["Khoday's Circle Underpass", '2025-05-16', DH_2025_05_16],
  ['Windsor Manor Bridge', '2025-05-16', DH_2025_05_16],
  ['Windsor Manor Bridge', '2024-10-21', DH_2024_10_21],
  ["Queen's Circle", '2025-05-16', DH_2025_05_16],
];

/** corrections where the reports name the same place two ways */
const OVERRIDE = {
  'Windsor Manor Bridge': { type: 'underpass', notes: 'Reported as the Windsor Manor bridge (2024) and as the Windsor Manor underpass (2025).' },
};

/** places that are not roads: lakes, walls, apartment complexes, villas, gated layouts */
const EXCLUDE = /\b(lake|retaining wall|apartments?|apartment|villas?|township|gardens|brooks)\b/i;
const TRANSIT = /\b(bus station|bus stand|bus depot|metro station|railway station|tech park|mall|theatre|market)\b/i;

// ------------------------------------------------------------------ helpers

const outletOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^(www|m|amp)\./, '');
  } catch {
    return '';
  }
};
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const r2 = (x) => Math.round(x * 100) / 100;
const clamp01 = (x) => (x > 1 ? 1 : x > 0 ? x : 0);
const osmium = (args) => execFileSync('osmium', args, { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'inherit'] });

/** distinct flood events: full dates within 2 days count once; a month-only date counts when no full date falls in its month */
export function reportDaysOf(dates) {
  const full = [...new Set(dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))];
  const months = new Set(full.map((d) => d.slice(0, 7)));
  const monthOnly = [...new Set(dates.filter((d) => /^\d{4}-\d{2}$/.test(d)))].filter((m) => !months.has(m));
  return eventCount(full) + monthOnly.length;
}

// ------------------------------------------------------------------ OSM highways (osmium)

const HW_RANK = { motorway: 7, trunk: 6, primary: 5, secondary: 4, tertiary: 3, unclassified: 2, residential: 2, living_street: 1, service: 1, road: 1 };
const rankOf = (hw) => HW_RANK[String(hw).replace(/_link$/, '')] ?? 0;

function loadHighways() {
  fs.mkdirSync(CACHE, { recursive: true });
  const src = path.join(ROOT, REGION_PBF);
  const opl = path.join(CACHE, 'highways.opl');
  if (!fs.existsSync(opl) || fs.statSync(opl).mtimeMs < fs.statSync(src).mtimeMs) {
    const clip = path.join(CACHE, 'blr.osm.pbf'), hw = path.join(CACHE, 'hw.osm.pbf'), loc = path.join(CACHE, 'hwl.osm.pbf');
    osmium(['extract', '-b', BBOX.join(','), '-s', 'complete_ways', src, '-o', clip, '--overwrite']);
    osmium(['tags-filter', clip, `w/highway=${Object.keys(HW_RANK).flatMap((k) => [k, `${k}_link`]).join(',')}`, '-o', hw, '--overwrite']);
    osmium(['add-locations-to-ways', hw, '-o', loc, '--overwrite']);
    osmium(['cat', loc, '-t', 'way', '-f', 'opl,add_metadata=false,locations_on_ways=true', '-o', opl, '--overwrite']);
    for (const f of [hw, loc]) fs.rmSync(f, { force: true });
  }
  const ways = [];
  for (const line of fs.readFileSync(opl, 'utf8').split('\n')) {
    if (line[0] !== 'w') continue;
    const parts = line.split(' ');
    const id = Number(parts[0].slice(1));
    const T = parts.find((p) => p[0] === 'T')?.slice(1) ?? '';
    const N = parts.find((p) => p[0] === 'N')?.slice(1) ?? '';
    const tags = {};
    for (const kv of T ? T.split(',') : []) {
      const eq = kv.indexOf('=');
      tags[unescapeOpl(kv.slice(0, eq))] = unescapeOpl(kv.slice(eq + 1));
    }
    const nodes = [], coords = [];
    for (const n of N ? N.split(',') : []) {
      const m = /^n(\d+)x([-\d.]+)y([-\d.]+)$/.exec(n);
      if (!m) continue;
      nodes.push(Number(m[1]));
      coords.push([Number(m[2]), Number(m[3])]);
    }
    if (coords.length >= 2) ways.push({ id, tags, nodes, coords, rank: rankOf(tags.highway) });
  }
  // grid index over segments (~220 m cells)
  const CELL = 0.002, grid = new Map();
  const key = (x, y) => `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;
  for (const w of ways)
    for (let i = 0; i + 1 < w.coords.length; i++) {
      const [a, b] = [w.coords[i], w.coords[i + 1]];
      for (let gx = Math.floor(Math.min(a[0], b[0]) / CELL); gx <= Math.floor(Math.max(a[0], b[0]) / CELL); gx++)
        for (let gy = Math.floor(Math.min(a[1], b[1]) / CELL); gy <= Math.floor(Math.max(a[1], b[1]) / CELL); gy++) {
          const k = `${gx}:${gy}`;
          if (!grid.has(k)) grid.set(k, new Set());
          grid.get(k).add(w);
        }
    }
  /** ways with any segment within r metres of p, with that distance */
  const near = (p, r) => {
    const out = new Map();
    const span = Math.ceil(r / 200) + 1;
    const [cx, cy] = [Math.floor(p[0] / CELL), Math.floor(p[1] / CELL)];
    for (let gx = cx - span; gx <= cx + span; gx++)
      for (let gy = cy - span; gy <= cy + span; gy++)
        for (const w of grid.get(`${gx}:${gy}`) ?? []) {
          if (out.has(w)) continue;
          const d = distToLine(p, w.coords);
          if (d <= r) out.set(w, d);
        }
    return [...out.entries()].map(([w, d]) => ({ w, d })).sort((a, b) => a.d - b.d);
  };
  void key;
  return { ways, near, byId: new Map(ways.map((w) => [w.id, w])) };
}

function distToLine(p, L) {
  const KX = 111320 * Math.cos((p[1] * Math.PI) / 180), KY = 110574;
  let best = Infinity;
  for (let i = 0; i + 1 < L.length; i++) {
    const ax = (L[i][0] - p[0]) * KX, ay = (L[i][1] - p[1]) * KY;
    const dx = (L[i + 1][0] - L[i][0]) * KX, dy = (L[i + 1][1] - L[i][1]) * KY;
    const L2 = dx * dx + dy * dy;
    const u = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(ax + u * dx, ay + u * dy));
  }
  return best;
}

/** the part of a place name before its first comma, without brackets: "Rainbow Drive Layout, Sarjapur Road" -> "Rainbow Drive Layout" */
const head = (n) => n.replace(/\s*\([^)]*\)\s*/g, ' ').split(',')[0].trim();
/** one report geocoded twice: the entries cite the same article and one name's core words contain the other's */
function sameReportedPlace(a, b) {
  if (!a.reports.some((r) => b.reports.some((q) => q.url === r.url))) return false;
  const A = coreTokens(head(a.name)), B = coreTokens(head(b.name));
  if (!A.length || !B.length) return false;
  const [s, l] = A.length <= B.length ? [A, new Set(B)] : [B, new Set(A)];
  return s.every((t) => l.has(t));
}
/** a lower-case slug that keeps the name's own words ("ST Bed Layout" -> st-bed-layout) */
const slug = (n) => n.toLowerCase().replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const wayNames = (w) => ['name', 'alt_name', 'old_name', 'official_name', 'name:en', 'loc_name'].map((k) => w.tags[k]).filter(Boolean);

/** the hotspot name and a way name share a distinctive word (or are similar names) */
function nameMatch(hotspotName, w) {
  const core = new Set(coreTokens(hotspotName).filter((t) => t.length >= 3));
  for (const n of wayNames(w)) {
    if (nameSimilar(hotspotName, n)) return true;
    if (coreTokens(n).some((t) => core.has(t))) return true;
  }
  return false;
}

function osmNode(id) {
  const opl = osmium(['getid', path.join(ROOT, REGION_PBF), `n${id}`, '-f', 'opl,add_metadata=false']).toString('utf8');
  const m = /x([-\d.]+) y([-\d.]+)/.exec(opl);
  if (!m) throw new Error(`OSM node ${id} not in the extract`);
  return [r5(Number(m[1])), r5(Number(m[2]))];
}

function placeOf(place, hw) {
  if (place.node) return osmNode(place.node);
  if (place.way) {
    const w = hw.byId.get(place.way);
    if (!w) throw new Error(`OSM way ${place.way} not in the extract`);
    const mid = w.coords[Math.floor(w.coords.length / 2)], first = w.coords[0];
    return [r5((mid[0] + first[0]) / 2), r5((mid[1] + first[1]) / 2)];
  }
  if (place.junction) {
    const [a, b] = place.junction;
    const A = hw.ways.filter((w) => w.tags.name === a), B = hw.ways.filter((w) => w.tags.name === b);
    const bNodes = new Map();
    for (const w of B) w.nodes.forEach((n, i) => bNodes.set(n, w.coords[i]));
    let best = null, bd = Infinity;
    for (const w of A)
      w.nodes.forEach((n, i) => {
        const c = bNodes.get(n) ?? null;
        const pt = c ?? w.coords[i];
        const d = metres(pt, place.near) + (c ? 0 : 1e4);
        if (d < bd) [best, bd] = [pt, d];
      });
    if (!best) throw new Error(`no ${a} in the extract`);
    return [r5(best[0]), r5(best[1])];
  }
  throw new Error('place needs node, way or junction');
}

// ------------------------------------------------------------------ terrain lowness

function lownessModel() {
  const flow = readFlowGrids(ROOT);
  if (!flow) throw new Error('needs .cache/city/flow60.{json,bin}: run npm run data:city (or --flow-only)');
  const { G, dir, acc, dem, drain, lake } = flow;
  const W = G.width, Hh = G.height;
  const thresh = 0.5e6 / G.cellArea;
  const isDrain = (i) => acc[i] >= thresh || drain[i] || lake[i];
  const hand = (i) => {
    let j = i;
    for (let k = 0; k < 20000 && j >= 0 && !isDrain(j); k++) j = downstream(j, dir[j], W);
    return j >= 0 ? Math.max(0, dem[i] - dem[j]) : NaN;
  };
  const city = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'city', 'city.geojson'), 'utf8'));
  const pins = city.features.filter((f) => f.properties.kind === 'pin');
  return (p) => {
    const c = Math.floor((p[0] - G.w) / G.dLon), r = Math.floor((G.n - p[1]) / G.dLat);
    let handM = Infinity;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < Hh && cc < W) {
          const h = hand(rr * W + cc);
          if (h < handM) handM = h;
        }
      }
    let sum = 0, n = 0;
    for (let dr = -5; dr <= 5; dr++)
      for (let dc = -5; dc <= 5; dc++) {
        if (dr * dr + dc * dc > 25) continue;
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < Hh && cc < W) {
          sum += dem[rr * W + cc];
          n++;
        }
      }
    const reliefM = n ? sum / n - dem[r * W + c] : 0;
    const pin = pins.find((f) => pointInGeometry(p, f.geometry));
    const pinS = pin ? pin.properties.s : 0.5;
    const lowness = r2(0.5 * clamp01(1 - handM / 6) + 0.3 * clamp01(reliefM / 3) + 0.2 * clamp01(pinS));
    return { lowness, low: { handM: r2(handM), reliefM: r2(reliefM), pin: pin?.properties.code ?? null, pinS } };
  };
}

// ------------------------------------------------------------------ type from name

const TYPE_RANK = { underpass: 6, flyover_ramp: 5, junction: 4, service_road: 3, road: 2, layout: 1 };
/** type from the names (each cut at its first comma: "Rainbow Drive Layout, Sarjapur Road" is a layout) and the news kinds */
function typeOf(names, kinds) {
  const heads = names.map(head);
  const all = heads.join(' | ');
  if (/underpass|under ?bridge|subway|\bRUB\b/i.test(all)) return 'underpass';
  if (/flyover|bridge/i.test(all)) return 'flyover_ramp';
  if (/service road/i.test(all)) return 'service_road';
  if (/circle|junction|signal|\bgate\b/i.test(all) || kinds.includes('junction')) return 'junction';
  if (TRANSIT.test(all)) return 'road';
  if (/\broad\b|\bstreet\b|\bmarg\b|\bcross\b/i.test(heads[0])) return 'road';
  if (/\b(layout|nagar|colony|block|stage|phase|town|palya|agrahara|halli)\b/i.test(heads[0])) return 'layout';
  if (kinds.includes('road')) return 'road';
  return 'layout';
}

// ------------------------------------------------------------------ build

function main() {
  if (!fs.existsSync(path.join(ROOT, REGION_PBF)) || !hasOsmium()) throw new Error(`needs ${REGION_PBF} (npm run data:osm) and osmium-tool`);
  const t0 = Date.now();
  const news = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'news-spots.json'), 'utf8')).spots;
  const cityRep = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'hotspots-city.json'), 'utf8'));
  const hw = loadHighways();
  log(`${hw.ways.length} highway ways from the OSM extract`);

  /** entries: { src, name, coord, kinds, reports: [{date, url, outlet}] } */
  const entries = [];
  for (const s of news) entries.push({ src: 'news', name: s.name, coord: s.coord, kinds: [s.kind], reports: s.reports.map((r) => ({ date: r.date, url: r.url, outlet: r.outlet })) });
  for (const s of cityRep)
    entries.push({ src: 'city', name: s.name, coord: s.coord, kinds: [kindOf(s.name.replace(/\s*\(.*\)\s*/g, '').split(',')[0]) ?? 'other'], reports: s.events.map((e) => ({ date: e.date, url: e.source, outlet: outletOf(e.source) })) });
  for (const x of EXTRA) {
    const coord = placeOf(x.place, hw);
    entries.push({ src: 'web', name: x.name, coord, kinds: [x.type === 'underpass' ? 'underpass' : x.type === 'junction' ? 'junction' : x.type === 'road' ? 'road' : 'layout'], reports: x.reports.map(([date, url]) => ({ date, url, outlet: outletOf(url) })) });
    log(`extra: ${x.name} at ${coord.join(', ')}`);
  }
  for (const [name, date, url] of EXTRA_AT) {
    const e = entries.filter((x) => normName(x.name) === normName(name))[0];
    if (!e) throw new Error(`EXTRA_AT: no place named ${name}`);
    e.reports.push({ date, url, outlet: outletOf(url) });
  }

  // 1. merge (union-find)
  const parent = entries.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < entries.length; i++)
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j];
      const d = metres(a.coord, b.coord);
      if (d <= 80 || (d <= 250 && nameSimilar(a.name, b.name)) || (d <= 3000 && normName(head(a.name)) === normName(head(b.name))) || (d <= 5000 && sameReportedPlace(a, b)))
        parent[find(i)] = find(j);
    }
  const groups = new Map();
  entries.forEach((e, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(e);
  });

  const lowAt = lownessModel();
  const places = [];
  for (const g of groups.values()) {
    const byUrl = new Map();
    for (const e of g) for (const r of e.reports) if (r.url && !byUrl.has(r.url)) byUrl.set(r.url, r);
    const reports = [...byUrl.values()].sort((a, b) => b.date.localeCompare(a.date));
    const pick = g.find((e) => e.src === 'web') ?? g.find((e) => e.src === 'city') ?? [...g].sort((a, b) => b.reports.length - a.reports.length)[0];
    const paren = /\(([^)]*)\)/.exec(pick.name)?.[1];
    const name = pick.name.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    const names = [name, ...g.map((e) => e.name)];
    const kinds = g.flatMap((e) => e.kinds);
    const extra = EXTRA.find((x) => x.name === pick.name);
    const over = OVERRIDE[name];
    const type = over?.type ?? extra?.type ?? typeOf(names, kinds);
    const dates = [...new Set(reports.map((r) => r.date))].sort().reverse();
    const years = dates.map((d) => Number(d.slice(0, 4))).filter(Number.isFinite);
    const aliases = [...new Set(g.map((e) => e.name.replace(/\s*\([^)]*\)\s*/g, ' ').trim()).filter((n) => normName(n) !== normName(name)))];
    places.push({ name, paren, type, coord: [r5(pick.coord[0]), r5(pick.coord[1])], reports, dates, years, aliases, all: names.join(' | '), keep: !!extra, note: over?.notes });
  }
  log(`${entries.length} report entries -> ${places.length} places`);
  for (const g of groups.values()) if (new Set(g.map((e) => normName(e.name))).size > 1) log(`  merged: ${g.map((e) => `${e.name} [${e.src}]`).join(' + ')}`);

  // 2. selection
  const kept = [];
  for (const p of places) {
    if (EXCLUDE.test(p.all)) {
      log(`  drop (not a road): ${p.name}`);
      continue;
    }
    p.reportDays = reportDaysOf(p.dates);
    const major = hw.near(p.coord, MAJOR_M).find((x) => x.w.rank >= 3);
    if (p.type === 'layout' && p.reportDays < 2 && !major && !p.keep) {
      log(`  drop (layout off the main roads, reported once): ${p.name}`);
      continue;
    }
    kept.push(p);
  }
  const score = (p) => TYPE_RANK[p.type] * 0.5 + p.reportDays + (p.keep ? 100 : 0);
  kept.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
  if (kept.length > MAX_HOTSPOTS) {
    for (const p of kept.slice(MAX_HOTSPOTS)) log(`  drop (over ${MAX_HOTSPOTS}): ${p.name}`);
    kept.length = MAX_HOTSPOTS;
  }

  // 3-6. ways, lowness, record
  const ids = new Set();
  const features = [];
  for (const p of kept) {
    const cand = hw.near(p.coord, MATCH_M);
    const named = cand.filter((x) => nameMatch(p.name, x.w) || p.aliases.some((a) => nameMatch(a, x.w)));
    let pick;
    if (named.length) pick = named.slice(0, 8);
    else if (p.type === 'junction') pick = cand.filter((x) => x.w.rank >= 3).slice(0, 8);
    else pick = [];
    if (!pick.length) pick = cand.filter((x) => x.w.rank >= 2).slice(0, 3);
    if (!pick.length) pick = cand.slice(0, 2);
    if (!pick.length) pick = hw.near(p.coord, 150).slice(0, 1);
    const struct = hw
      .near(p.coord, STRUCT_M)
      .filter((x) => (p.type === 'underpass' ? x.w.tags.tunnel === 'yes' || Number(x.w.tags.layer) < 0 : p.type === 'flyover_ramp' ? x.w.tags.bridge === 'yes' || /_link$/.test(x.w.tags.highway) : false));
    const ways = [...new Set([...pick, ...struct.slice(0, 6)].map((x) => x.w.id))].slice(0, 12);
    const { lowness, low } = lowAt(p.coord);
    let id = slug(p.name);
    for (let k = 2; ids.has(id); k++) id = `${slug(p.name)}-${k}`;
    ids.add(id);
    const sources = [];
    for (const r of p.reports) if (sources.length < 3 && !sources.some((s) => s.url === r.url)) sources.push({ date: r.date, url: r.url, outlet: r.outlet || outletOf(r.url) });
    const notes = [];
    if (p.paren) notes.push(p.paren.charAt(0).toUpperCase() + p.paren.slice(1) + '.');
    if (p.note) notes.push(p.note);
    if (p.aliases.length) notes.push(`Also reported as ${p.aliases.slice(0, 3).join('; ')}.`);
    if (p.type === 'flyover_ramp') notes.push('Reports describe the ramps and the road at the flyover; a route on the deck may pass dry.');
    if (TRANSIT.test(p.all)) notes.push('Reports describe the roads around it.');
    if (!ways.length) notes.push('No OSM road within 150 m.');
    const props = {
      id,
      name: p.name,
      type: p.type,
      coord: p.coord,
      ways,
      lowness,
      reportDays: p.reportDays,
      years: p.years.length ? [Math.min(...p.years), Math.max(...p.years)] : null,
      sources,
      ...(notes.length ? { notes: notes.join(' ') } : {}),
      dates: p.dates,
      low,
    };
    const errs = hotspotErrors(props);
    if (errs.length) throw new Error(errs.join('\n'));
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p.coord }, properties: props });
  }
  features.sort((a, b) => a.properties.id.localeCompare(b.properties.id));

  const byType = {};
  for (const f of features) byType[f.properties.type] = (byType[f.properties.type] ?? 0) + 1;
  const osmInfo = path.join(ROOT, '.cache', 'osm', 'blr-region.json');
  const osmDate = fs.existsSync(osmInfo) ? JSON.parse(fs.readFileSync(osmInfo, 'utf8')).built.slice(0, 10) : 'unknown';
  const fc = {
    type: 'FeatureCollection',
    generated: new Date().toISOString().slice(0, 10),
    about:
      'Commute flood hotspots in Bengaluru Urban (scripts/commute/build-hotspots.mjs): places on commuter roads with sourced news reports of waterlogging. ' +
      'Properties follow CommuteHotspot (src/commute/types.ts); `dates` lists every report date and `low` the lowness inputs. Reports are links only; coverage follows the news, so busy roads are over-represented.',
    licence: `Positions and ways: © OpenStreetMap contributors, ODbL 1.0 (extract ${osmDate}). Lowness: Copernicus DEM GLO-30 (© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA). Reports: links to the cited outlets.`,
    counts: { hotspots: features.length, byType },
    features,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(fc, null, 0).replace(/\{"type":"Feature"/g, '\n{"type":"Feature"') + '\n');
  log(`${features.length} hotspots (${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(', ')}) -> ${path.relative(ROOT, OUT)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main();
