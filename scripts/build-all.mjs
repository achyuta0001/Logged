#!/usr/bin/env node
// Build every pincode pack (or a subset), resumably, then refresh public/data/pins/index.json.
//
//   npm run data:all                          every pincode in .cache/pins/catalog.json
//   npm run data:all -- --pins 560034,560103  just these
//   npm run data:all -- --force               rebuild packs that already exist
//   npm run data:all -- --jobs 2              packs in parallel (each needs ~1-2 GB RAM)
//
// Resumable: a pack with a pack.json is skipped unless --force. Polite: OSM comes from the local
// extract (no Overpass calls when it exists); Copernicus windows are cached in .cache/; a failed
// pack is retried with exponential backoff (capped at 15 min) before moving on.
// Packs other than 560098 land in public/data/pins/<code>/ (git-ignored except committed samples).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const force = process.argv.includes('--force');
const jobs = Math.max(1, Number(arg('jobs', '1')) || 1);
const log = (...a) => console.log('[all]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const catalogFile = path.join(ROOT, '.cache', 'pins', 'catalog.json');
if (!fs.existsSync(catalogFile)) {
  console.error('no .cache/pins/catalog.json: run npm run data:city first');
  process.exit(1);
}
const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
const want = arg('pins', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
for (const c of want) if (!catalog.pins.some((p) => p.code === c)) console.warn(`[all] ${c} is not in the catalog; skipped`);
const todo = catalog.pins.filter((p) => !want.length || want.includes(p.code)).map((p) => p.code);
const outDir = (code) => (code === '560098' ? path.join(ROOT, 'public', 'data') : path.join(ROOT, 'public', 'data', 'pins', code));

function buildOne(code) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const logFile = path.join(ROOT, '.cache', 'pins', code, 'build.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.createWriteStream(logFile);
    const p = spawn(process.execPath, ['--max-old-space-size=6144', path.join(ROOT, 'scripts', 'build-data.mjs'), '--pin', code], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.pipe(out);
    p.stderr.pipe(out);
    p.on('close', (rc) => resolve({ ok: rc === 0, s: (Date.now() - t0) / 1000, logFile }));
  });
}

const results = [];
let next = 0;
async function worker() {
  while (next < todo.length) {
    const code = todo[next++];
    if (!force && fs.existsSync(path.join(outDir(code), 'pack.json'))) {
      results.push({ code, status: 'cached' });
      continue;
    }
    let r;
    for (let attempt = 0; attempt < 4; attempt++) {
      r = await buildOne(code);
      if (r.ok) break;
      const wait = Math.min(900, 20 * 2 ** attempt);
      log(`${code} failed (see ${path.relative(ROOT, r.logFile)}); retry in ${wait}s`);
      await sleep(wait * 1000);
    }
    const k = r.ok ? JSON.parse(fs.readFileSync(path.join(outDir(code), 'pack.json'), 'utf8')) : null;
    results.push({ code, status: r.ok ? 'built' : 'FAILED', s: r.s, gz: k?.gzipBytes });
    log(`${code} ${r.ok ? 'built' : 'FAILED'} in ${r.s.toFixed(0)} s${k ? `, ${(k.gzipBytes / 1e6).toFixed(2)} MB gzipped` : ''} [${results.length}/${todo.length}]`);
  }
}
await Promise.all(Array.from({ length: jobs }, worker));

// refresh the index with the packs that now exist
await new Promise((resolve) => spawn(process.execPath, [path.join(ROOT, 'scripts', 'build-city.mjs'), '--index-only'], { cwd: ROOT, stdio: 'inherit' }).on('close', resolve));
const failed = results.filter((r) => r.status === 'FAILED');
log(`${results.filter((r) => r.status === 'built').length} built, ${results.filter((r) => r.status === 'cached').length} already built, ${failed.length} failed${failed.length ? `: ${failed.map((r) => r.code).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
