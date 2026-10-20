#!/usr/bin/env node
// Browser smoke test of the production build. Serves dist/ with `vite preview`, opens the city
// overview and the committed packs in headless Chromium (playwright-core, Apache-2.0), and waits
// until each view is ready: the loader closes (for a pincode that happens only after the first
// prediction, which the console also reports as "[sim] N h in M ms"). It fails on any uncaught page
// error, console error or failed request to the app's own server. Screenshots go to .cache/smoke/.
//
//   npx vite build && npm run smoke                     test the build in dist/
//   npm run smoke -- --url https://achyuta0001.github.io/Logged/   test a deployed site instead
//   npm run smoke -- --pins 560034 --no-city            only some views
//   npm run smoke -- --out /tmp/shots --timeout 180000  screenshot folder, per-view timeout (ms)
//   npm run smoke -- --dist /tmp/build --port 4180      another build folder, first port to try
//   npm run smoke -- --no-tiles                         skip third-party basemap, terrain and fonts (CI:
//                                                       ~7x less CPU; the app's fallback style is used)
//   npx playwright-core install chromium-headless-shell  once, for the browser (CI adds --with-deps)
//
// Asserts on the DOM and the console, not on pixels: headless WebGL is SwiftShader on Linux (the
// flags below) and may render black elsewhere. SwiftShader draws on the CPU, so each view runs with
// reduced motion (the app then skips its intro flight and draws water and rain as still frames
// instead of animating them every frame) in a 1024 x 640 window (the same layout band as a laptop).
// Service workers are blocked: each view starts from a fresh context and tests the app, not the
// worker. Third-party failures (basemap, terrain tiles, rain forecast, fonts) are listed but do not
// fail the run; the app falls back when they are down.
// Known and harmless: the 560098 reference pack has no .gz files, so its .gz probes 404 on a static
// host (src/pack/fetch.ts falls back to the plain file).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const OUT = path.resolve(ROOT, arg('out', path.join('.cache', 'smoke')));
const TIMEOUT = Number(arg('timeout', '120000'));
/** after the loader closes: keep listening for late errors (background runs, tiles) before the screenshot */
const SETTLE_MS = Number(arg('settle', '3000'));
const PINS = arg('pins', '560034,560071,560098').split(',').map((s) => s.trim()).filter(Boolean);
const VIEWS = [...(process.argv.includes('--no-city') ? [] : [{ name: 'city', query: '' }]), ...PINS.map((p) => ({ name: p, query: `?pin=${p}`, pin: true }))];
// SwiftShader WebGL where there is no GPU (CI); SMOKE_GL=gpu keeps Chromium's own choice
const GL = process.env.SMOKE_GL ?? (process.platform === 'linux' ? 'swiftshader' : 'gpu');
const GL_ARGS = GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : ['--ignore-gpu-blocklist'];
/** --no-tiles: no third-party basemap style, tiles, terrain or fonts, so the map draws only the app's own layers (far less software WebGL) */
const NO_TILES = process.argv.includes('--no-tiles');
const TILE_HOSTS = /^https:\/\/(tiles\.openfreemap\.org|s3\.amazonaws\.com\/elevation-tiles-prod|tiles\.maps\.eox\.at|fonts\.(googleapis|gstatic)\.com)\//;
const SIM_LINE = /^\[sim\] \d+ h in \d+ ms/;
/** the 560098 reference pack's .gz probes (format 1 keeps plain JSON; src/pack/fetch.ts falls back) */
const KNOWN_404 = /\/data\/(osm\.geojson|depressions\.json)\.gz$/;
const log = (...a) => console.log('[smoke]', ...a);

let server = null;
let base = arg('url', process.env.SMOKE_URL ?? '');
if (!base) {
  const dist = path.resolve(ROOT, arg('dist', 'dist'));
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    console.error(`[smoke] no ${path.relative(ROOT, dist)}/index.html: run \`npx vite build\` first (or pass --url)`);
    process.exit(1);
  }
  const { preview } = await import('vite');
  // 4173 is Vite's preview port; the next free one is taken when it is busy
  server = await preview({ root: ROOT, logLevel: 'warn', build: { outDir: dist }, preview: { host: '127.0.0.1', port: Number(arg('port', '4173')), strictPort: false, open: false } });
  base = server.resolvedUrls?.local?.[0];
  if (!base) throw new Error('vite preview did not report a URL');
}
base = base.endsWith('/') ? base : `${base}/`;
const origin = new URL(base).origin;
const own = (u) => {
  try {
    return new URL(u).origin === origin;
  } catch {
    return false;
  }
};
fs.mkdirSync(OUT, { recursive: true });
log(`${base} (WebGL: ${GL}), screenshots in ${path.relative(ROOT, OUT) || '.'}`);

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: GL_ARGS });
const results = [];
const line = (r) =>
  `${r.errors.length ? 'FAIL' : 'ok  '} ${r.name.padEnd(6)} ${r.readyS != null ? `ready in ${r.readyS.toFixed(1)} s` : 'not ready'}${r.sim ? `, ${r.sim}` : ''}${r.external.length ? `, ${r.external.length} third-party failures ignored` : ''}${r.known ? `, ${r.known} known .gz probe 404s` : ''}`;
try {
  for (const v of VIEWS) {
    const r = await check(v);
    results.push(r);
    log(line(r));
    for (const e of r.errors) log(`       ${e}`);
  }
} finally {
  await browser.close();
  await server?.close();
}

const failed = results.filter((r) => r.errors.length);
log('summary');
for (const r of results) log(`  ${line(r)}`);
log(failed.length ? `${failed.length} of ${results.length} views failed` : `all ${results.length} views ok`);
process.exit(failed.length ? 1 : 0);

/** Open one view in a fresh browser context and collect what went wrong. */
async function check(v) {
  const r = { name: v.name, errors: [], external: [], known: 0, warnings: 0, readyS: null, sim: '' };
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 640 }, deviceScaleFactor: 1, reducedMotion: 'reduce', serviceWorkers: 'block' });
  if (NO_TILES) await ctx.route(TILE_HOSTS, (route) => route.abort('blockedbyclient'));
  const page = await ctx.newPage();
  log(`${v.name}: opening ${new URL(v.query, base).href}`);
  page.on('pageerror', (e) => r.errors.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'info' && SIM_LINE.test(text)) r.sim ||= text.replace('[sim] ', 'prediction ');
    if (m.type() === 'warning') r.warnings++;
    if (m.type() !== 'error') return;
    const at = m.location()?.url ?? '';
    if (/^Failed to load resource/.test(text)) {
      if (!own(at)) r.external.push(`${text} ${at}`);
      else if (/status of 404/.test(text) && KNOWN_404.test(new URL(at).pathname)) r.known++;
      else r.errors.push(`console: ${text} ${at}`);
      return;
    }
    // e.g. MapLibre logging a tile it could not fetch: third party when every URL its message names
    // is (only the first line: the stack trace below it names the app's own bundle)
    const urls = text.split('\n')[0].match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
    if (urls.length && !urls.some(own)) r.external.push(text.slice(0, 300));
    else r.errors.push(`console: ${text.slice(0, 500)}${at ? ` (${at})` : ''}`);
  });
  page.on('requestfailed', (q) => {
    const why = q.failure()?.errorText ?? '';
    if (own(q.url()) && !/ERR_ABORTED/.test(why)) r.errors.push(`request failed: ${q.url()} ${why}`);
  });
  page.on('response', (s) => {
    // Chromium also logs these as console errors, which the console handler sorts; this catches the rest
    if (s.status() >= 400 && own(s.url()) && !(s.status() === 404 && KNOWN_404.test(new URL(s.url()).pathname)) && !s.request().isNavigationRequest()) {
      const msg = `HTTP ${s.status()} ${s.url()}`;
      if (!r.errors.some((e) => e.includes(s.url()))) r.errors.push(msg);
    }
  });

  const t0 = Date.now();
  try {
    const res = await page.goto(new URL(v.query, base).href, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    if (!res?.ok()) r.errors.push(`HTTP ${res?.status()} for the page itself`);
    // the loader closes once the view is drawn: for a pincode, after its first prediction
    await page.waitForFunction(() => document.querySelector('#loader.done, #loader.error'), null, { timeout: TIMEOUT, polling: 250 });
    const state = await page.evaluate(() => {
      const l = document.getElementById('loader');
      const c = document.querySelector('#map canvas.maplibregl-canvas');
      const gl = c && (c.getContext('webgl2') ?? c.getContext('webgl'));
      const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
      return {
        error: l?.classList.contains('error') ? (l.querySelector('.ld-msg')?.textContent ?? 'loader error') : '',
        canvas: !!c,
        size: c ? [c.width, c.height] : null,
        renderer: gl ? String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : '',
      };
    });
    r.readyS = (Date.now() - t0) / 1000;
    if (state.error) r.errors.push(`loader: ${state.error}`);
    if (!state.canvas) r.errors.push('no MapLibre canvas in #map');
    else if (!state.renderer) r.errors.push('the map canvas has no WebGL context');
    r.renderer = state.renderer;
    if (v.pin && !r.sim && !state.error) log(`${v.name}: loader closed without a "[sim] N h in M ms" console line (console stripped from the build?)`);
    await page.waitForTimeout(SETTLE_MS);
  } catch (e) {
    r.errors.push(`not ready after ${((Date.now() - t0) / 1000).toFixed(0)} s: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
    const msg = await page.locator('#loader .ld-msg').textContent({ timeout: 1000 }).catch(() => null);
    if (msg) r.errors.push(`loader says: ${msg}`);
  }
  await page.screenshot({ path: path.join(OUT, `${v.name}.png`), timeout: 60000 }).catch((e) => log(`${v.name}: no screenshot (${e.message.split('\n')[0]})`));
  if (r.renderer) log(`${v.name}: WebGL ${r.renderer}`);
  for (const x of r.external.slice(0, 5)) log(`${v.name}: third party (ignored): ${x}`);
  await ctx.close();
  return r;
}
