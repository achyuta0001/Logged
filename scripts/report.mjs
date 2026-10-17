#!/usr/bin/env node
// M5 results table: runs scripts/calibrate.mjs headlessly for a set of pincode packs and prints a
// markdown table (the one in the PR / README).
//
//   node scripts/report.mjs --pins 560098,560034,560103 [--perf] [--out .cache/report.md]
//
// Per pincode: pack size, grid, and for the 20 Oct 2024 storm and a typical monsoon evening the peak
// flooded area (> 0.1 m inside the pincode), hours after the rain to fall below 25 % of that peak,
// buildings with water over the plinth (> 0.25 m) and road closed to cars (> 0.30 m) at the peak hour,
// plus how many sourced flood reports the model wets (street water >= 0.15 m within 300 m).
// --perf adds the time for a 216-hour (9-day) forecast-like series.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const pins = arg('pins', '560098').split(',').map((s) => s.trim()).filter(Boolean);
const perf = process.argv.includes('--perf');
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/pins/index.json'), 'utf8'));
const dirOf = (c) => (c === '560098' ? 'public/data' : `public/data/pins/${c}`);
const MATCH = 0.15;

const rows = [];
for (const code of pins) {
  const save = path.join('.cache', 'calib', `${code}.json`);
  const t0 = Date.now();
  execFileSync(process.execPath, ['--max-old-space-size=6144', 'scripts/calibrate.mjs', '--pin', code, '--impact', '--save', save, ...(perf ? ['--perf'] : [])], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  const r = JSON.parse(fs.readFileSync(path.join(ROOT, save), 'utf8'));
  const pj = path.join(ROOT, dirOf(code), 'pack.json');
  const pack = fs.existsSync(pj) ? JSON.parse(fs.readFileSync(pj, 'utf8')) : null;
  const entry = index.pins.find((p) => p.code === code);
  rows.push({ code, name: entry?.name ?? r.name, s: entry?.susceptibility, r, pack });
  console.error(`[report] ${code} done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

const km2 = (m2) => (m2 / 1e6).toFixed(2);
const sc = (r, id) => r.scenarios[id];
const hot = (x) => {
  if (!x.hotspots.length) return '–';
  const wet = x.hotspots.filter((h) => (h.street300 ?? 0) >= MATCH).length;
  return `${wet}/${x.hotspots.length}`;
};
const lines = [
  `| Pincode | Name | Susc. | Grid | Pack (gz) | Oct 2024 storm: peak flooded | recession | buildings over plinth | road closed (car) | reports wet | Typical evening: peak | buildings | ${perf ? '9-day run |' : ''}`,
  `|---|---|---|---|---|---|---|---|---|---|---|---|${perf ? '---|' : ''}`,
];
for (const { code, name, s, r, pack } of rows) {
  const a = sc(r, 'rrnagar-2024-10-20');
  const b = sc(r, 'typical-evening');
  lines.push(
    `| ${code} | ${name} | ${s?.toFixed(2) ?? '–'} | ${r.cellSizeM} m, ${Math.round(r.cells / 1000)}k | ${pack ? (pack.gzipBytes / 1e6).toFixed(2) + ' MB' : '–'} | ${km2(a.peakAreaM2)} km² | ${a.recessionH ?? '>' + (a.hours - 1 - a.rainEnd)} h | ${a.impact?.buildingsWet ?? '–'} | ${a.impact?.roadClosedCarKm.toFixed(1) ?? '–'} km | ${hot(a)} | ${km2(b.peakAreaM2)} km² | ${b.impact?.buildingsWet ?? '–'} | ${perf ? `${(r.perf.ms / 1000).toFixed(1)} s |` : ''}`,
  );
}
const md = lines.join('\n');
console.log(md);
const out = arg('out');
if (out) fs.writeFileSync(path.resolve(ROOT, out), md + '\n');
