#!/usr/bin/env node
// Accessibility audit: axe-core (WCAG 2.0/2.1/2.2 A + AA, plus best practice) in headless Chrome
// via playwright-core, against the Vite dev server. Free and open: axe-core (MPL-2.0) and
// playwright-core (Apache-2.0) are dev dependencies; Chrome is the one already installed.
//
//   npm run a11y                               start Vite on :5176, audit every view, stop Vite
//   npm run a11y -- --url http://localhost:5173 audit a server that is already running
//   npm run a11y -- --views city,search        only some views (city, search, pin, place, commute, news,
//                                              tour, toast, phone, tab-commute, tab-trip, tab-phone)
//   npm run a11y -- --tab                      also walk the page with Tab and screenshot each focus
//   npm run a11y -- --json report.json         write the full axe results
//   npm run a11y -- --no-fail                  exit 0 even when violations are found
//
// Env: CHROME_PATH picks the browser binary (default: the installed Google Chrome).
// Screenshots go to .cache/a11y/ (git-ignored).
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const AXE = require.resolve('axe-core/axe.min.js');
const ROOT = resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const PORT = Number(opt('port', process.env.A11Y_PORT ?? 5176));
const OUT = resolve(ROOT, opt('out', '.cache/a11y'));
const PIN = opt('pin', '560034');
/** a shared Commute-tab trip: Jayanagar -> Manyata Tech Park, 09:00, back 18:00 */
const COMMUTE_TRIP = 'from=77.5838,12.9299&to=77.6208,13.0475&dep=09:00&ret=18:00&fromName=Jayanagar&toName=Manyata%20Tech%20Park';
const TIMEOUT = Number(opt('timeout', 120000));

/** Every view starts from a fresh page; `setup` brings it to the state worth auditing. */
const VIEWS = {
  city: { path: '/', note: 'Bengaluru Urban overview' },
  search: {
    path: '/',
    note: 'overview, pincode search with results open',
    async setup(p) {
      await p.fill('.city-search input', 'kora');
      await p.waitForSelector('.city-results:not([hidden]) .city-row', { timeout: 5000 });
    },
  },
  pin: {
    path: `/?pin=${PIN}`,
    note: `pincode ${PIN}, every section and sub-list expanded`,
    async setup(p) {
      await expandAll(p);
    },
  },
  place: {
    path: `/?pin=${PIN}`,
    note: `pincode ${PIN}, Your place: search list open, then a place pinned`,
    async setup(p, audit) {
      await p.evaluate(() => document.querySelector('[data-rail="place"], #sec-place-btn') && document.getElementById('sec-place')?.removeAttribute('hidden'));
      const open = await p.$('#sec-place-btn[aria-expanded="false"]');
      if (open) await open.click();
      const q = p.locator('#sec-place input[type="search"]');
      await q.fill('road');
      await p.waitForSelector('#sec-place [role="listbox"]:not([hidden])', { timeout: 5000 });
      await audit('list open');
      await q.press('Enter');
      await p.waitForSelector('#sec-place .pl-card:not([hidden])', { timeout: 10000 });
      await p.waitForTimeout(1500);
    },
  },
  commute: {
    // a shared commute link: Your place -> destination at a departure time (src/ui/place.ts)
    path: `/?pin=${PIN}&from=77.6205,12.9285&to=77.6420,12.9330&dep=08:30`,
    note: `pincode ${PIN}, Your place with the commute check from a shared link`,
    async setup(p) {
      const open = await p.$('#sec-place-btn[aria-expanded="false"]');
      if (open) await open.click();
      await p.waitForSelector('#sec-place .pl-commute:not([hidden])', { timeout: 20000 });
      await p.waitForTimeout(2500);
    },
  },
  news: {
    path: `/?pin=${PIN}`,
    note: `pincode ${PIN}, news flood reports layer on and one report card open`,
    async setup(p) {
      await expandAll(p);
      const sw = p.locator('input[data-layer="news"]');
      if (!(await sw.isChecked())) await sw.check();
      await p.waitForTimeout(1500);
      // dev builds expose the app (src/main.ts): click the first news circle on screen
      const pt = await p.evaluate(() => {
        const map = window.__app?.map;
        const ids = (map?.getStyle().layers ?? []).map((l) => l.id).filter((id) => /^news/.test(id));
        const f = ids.length ? map.queryRenderedFeatures({ layers: ids })[0] : null;
        if (!f) return null;
        const c = map.project(f.geometry.coordinates);
        const r = map.getCanvas().getBoundingClientRect();
        return { x: r.left + c.x, y: r.top + c.y };
      });
      if (!pt) throw new Error('no news report on screen');
      await p.mouse.click(pt.x, pt.y);
      await p.waitForSelector('.maplibregl-popup', { timeout: 5000 });
    },
  },
  toast: {
    path: '/',
    note: 'overview with the "Updated" toast (built like src/sw-register.ts showUpdated(); production only)',
    async setup(p) {
      await p.evaluate(() => {
        const el = document.createElement('div');
        el.id = 'sw-updated';
        el.className = 'glass';
        el.setAttribute('role', 'status');
        el.style.cssText =
          'position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:60;display:flex;align-items:center;gap:10px;padding:6px 6px 6px 16px;border-radius:999px;font-size:13px;';
        el.innerHTML = '<span>Updated</span><button type="button" class="btn primary" style="width:auto;height:30px;font-size:13px">Reload</button>';
        document.body.append(el);
      });
    },
  },
  tour: {
    path: `/?pin=${PIN}`,
    note: `pincode ${PIN}, guided tour running`,
    async setup(p) {
      await p.click('#tour-btn');
      await p.waitForSelector('.tour-card.in', { timeout: 5000 });
      await p.waitForTimeout(1500);
    },
  },
  phone: {
    path: `/?pin=${PIN}`,
    note: `pincode ${PIN} on a 390 x 844 phone, sheet expanded`,
    viewport: { width: 390, height: 844 },
    async setup(p) {
      await p.click('#sb-min');
      await p.waitForTimeout(600);
    },
  },
  // the Commute tab (src/ui/commute/): an empty card with the place list open, a saved trip with its
  // routes and a hotspot's Why card, and the same on a phone
  'tab-commute': {
    path: '/?commute=1',
    note: 'Commute tab, empty card, then the Home place list open',
    async setup(p, audit) {
      await p.waitForSelector('#sec-commute .cm-city:not([hidden]), #sec-commute .cm-msg[data-tone="error"]', { timeout: 30000 });
      await audit('empty');
      await p.fill('#cm-home-q', 'kora');
      await p.waitForSelector('#cm-home-list:not([hidden]) .cm-opt', { timeout: 5000 });
    },
  },
  'tab-trip': {
    path: `/?commute=1&${COMMUTE_TRIP}`,
    note: 'Commute tab with a shared trip: routes, the hotspots on route A, then one Why card',
    async setup(p, audit) {
      await p.waitForSelector('#sec-commute .cm-result:not([hidden])', { timeout: 30000 });
      await audit('routes');
      const spot = await p.$('#sec-commute [data-spot]');
      if (spot) {
        await spot.click();
        await p.waitForSelector('#sec-commute .cm-why:not([hidden])', { timeout: 5000 });
      }
    },
  },
  'tab-phone': {
    path: `/?commute=1&${COMMUTE_TRIP}`,
    note: 'Commute tab with a shared trip on a 390 x 844 phone, sheet expanded',
    viewport: { width: 390, height: 844 },
    async setup(p) {
      await p.waitForSelector('#sec-commute .cm-result:not([hidden])', { timeout: 30000 });
      await p.click('#sb-min');
      await p.waitForTimeout(600);
    },
  },
};
const wanted = (opt('views', '') || Object.keys(VIEWS).join(',')).split(',').filter((v) => VIEWS[v]);

async function expandAll(p) {
  // the per-model ranges arrive from a second worker after the first prediction
  await p.waitForSelector('#ens-more:not([hidden])', { timeout: 30000 }).catch(() => {});
  await p.evaluate(() => {
    const vis = (el) => !el.closest('[hidden], .off-scope, .empty');
    document.querySelectorAll('.sb-toggle[aria-expanded="false"]').forEach((b) => vis(b) && b.click());
    document.querySelectorAll('.sub-toggle[aria-expanded="false"], .lg-toggle[aria-expanded="false"], #life-more[aria-expanded="false"], #ens-more[aria-expanded="false"]').forEach((b) => vis(b) && b.click());
    document.querySelectorAll('details:not([open])').forEach((d) => (d.open = true));
  });
  await p.waitForTimeout(800);
}

// ---------------------------------------------------------------- server + browser
async function startVite() {
  const { createServer } = await import('vite');
  const server = await createServer({ root: ROOT, logLevel: 'warn', server: { port: PORT, strictPort: true, open: false } });
  await server.listen();
  return server;
}

function chromeOptions() {
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const exe = process.env.CHROME_PATH || (existsSync(mac) ? mac : undefined);
  // the map is WebGL: use the GPU where there is one, SwiftShader elsewhere
  const args = process.platform === 'darwin' ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  return { headless: true, args, ...(exe ? { executablePath: exe } : { channel: 'chrome' }) };
}

async function openView(browser, base, view) {
  const page = await browser.newPage({ viewport: view.viewport ?? { width: 1440, height: 900 }, reducedMotion: 'reduce', deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + view.path);
  await page.waitForFunction(() => document.getElementById('loader')?.classList.contains('done'), null, { timeout: TIMEOUT });
  await page.waitForTimeout(800);
  return { page, errors };
}

// ---------------------------------------------------------------- axe
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
/**
 * axe cannot see through the glass panels to the WebGL map, so colour contrast would come back
 * "needs review". The map canvas is hidden while axe runs, over a stand-in colour: the 90th
 * percentile of the map measured under the glass (dark and satellite basemaps, 560034).
 */
const BACKDROP = 'rgb(37, 51, 80)';
async function runAxe(page) {
  if (!(await page.evaluate(() => 'axe' in window))) await page.addScriptTag({ path: AXE });
  const shim = await page.addStyleTag({ content: `.maplibregl-canvas{display:none!important}#map{background:${BACKDROP}!important}` });
  return page.evaluate(
    async (tags) =>
      // the map canvas is a WebGL surface: axe cannot read text there, so it is excluded
      // eslint-disable-next-line no-undef
      axe.run({ include: [document], exclude: [['.maplibregl-canvas']] }, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations', 'incomplete'] }),
    TAGS,
  ).finally(() => shim.evaluate((el) => el.remove()));
}
const isWcag = (v) => v.tags.some((t) => /^wcag\d/.test(t));

function summarise(name, label, res) {
  const v = res.violations;
  const wc = v.filter(isWcag);
  const bp = v.filter((x) => !isWcag(x));
  const nodes = (xs) => xs.reduce((a, x) => a + x.nodes.length, 0);
  console.log(`\n■ ${name}${label ? ` (${label})` : ''}: ${wc.length} WCAG rules / ${nodes(wc)} nodes, ${bp.length} best-practice rules / ${nodes(bp)} nodes, ${res.incomplete.length} need review`);
  for (const x of v) {
    console.log(`  ${x.impact?.padEnd(8) ?? ''} ${x.id} (${x.nodes.length}) ${x.help}`);
    for (const n of x.nodes.slice(0, 4)) console.log(`      ${n.target.join(' ')}${n.any?.[0]?.message ? `  · ${n.any[0].message.slice(0, 140)}` : ''}`);
  }
  return { view: name, label, wcagRules: wc.length, wcagNodes: nodes(wc), bpRules: bp.length, bpNodes: nodes(bp), incomplete: res.incomplete.length };
}

// ---------------------------------------------------------------- keyboard pass
async function tabWalk(page, name, steps = 70) {
  mkdirSync(OUT, { recursive: true });
  // start from the top of the document: the skip link must be the first stop
  await page.evaluate(() => document.activeElement?.blur?.());
  const seen = [];
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      // a ring on the element, or on the field wrapping it (inputs drawn inside a :focus-within box)
      const wrap = el.parentElement && getComputedStyle(el.parentElement);
      const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none' || (!!wrap && wrap.boxShadow !== 'none' && el.matches('input'));
      const label = el.labels?.[0]?.textContent;
      const name = (el.getAttribute('aria-label') || label || el.textContent || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      const onScreen = r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
      return { tag: el.tagName.toLowerCase(), id: el.id, cls: String(el.className?.baseVal ?? el.className).split(' ')[0], role: el.getAttribute('role') ?? '', name, ring, onScreen, x: r.x, y: r.y, w: r.width, h: r.height };
    });
    if (!f) continue;
    const key = `${f.tag}#${f.id}.${f.cls}:${f.name}`;
    if (seen.length && seen[0].key === key) break; // wrapped round
    seen.push({ key, ...f });
    if (f.onScreen) {
      const pad = 14;
      const vp = page.viewportSize();
      const clip = { x: Math.max(0, f.x - pad), y: Math.max(0, f.y - pad), width: Math.min(vp.width, f.w + pad * 2), height: Math.min(vp.height, f.h + pad * 2) };
      clip.width = Math.min(clip.width, vp.width - clip.x);
      clip.height = Math.min(clip.height, vp.height - clip.y);
      if (clip.width > 2 && clip.height > 2) await page.screenshot({ path: `${OUT}/${name}-tab-${String(i + 1).padStart(2, '0')}.png`, clip });
    }
  }
  console.log(`\n⇥ ${name}: ${seen.length} tab stops`);
  for (const [i, s] of seen.entries())
    console.log(`  ${String(i + 1).padStart(2)} ${s.ring ? 'ring' : 'NO RING'} ${s.onScreen ? '' : 'OFF-SCREEN '}${s.tag}${s.role ? `[${s.role}]` : ''}${s.id ? `#${s.id}` : ''} “${s.name}”`);
  return seen;
}

// ---------------------------------------------------------------- main
const server = opt('url') ? null : await startVite();
const base = (opt('url') ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const browser = await chromium.launch(chromeOptions());
const rows = [];
const full = {};
let failed = false;
try {
  for (const name of wanted) {
    const view = VIEWS[name];
    const { page, errors } = await openView(browser, base, view);
    const audit = async (label) => {
      const res = await runAxe(page);
      full[label ? `${name}:${label}` : name] = res;
      rows.push(summarise(name, label, res));
    };
    try {
      await view.setup?.(page, audit);
      await audit('');
      if (flag('tab') && (name === 'city' || name === 'pin' || name === 'tab-trip')) {
        if (name === 'pin') await page.reload().then(() => page.waitForFunction(() => document.getElementById('loader')?.classList.contains('done'), null, { timeout: TIMEOUT }));
        const stops = await tabWalk(page, name);
        if (stops.some((s) => !s.ring || !s.onScreen)) console.log(`  ⚠ ${stops.filter((s) => !s.ring).length} without a visible ring, ${stops.filter((s) => !s.onScreen).length} off-screen`);
      }
    } catch (e) {
      console.log(`\n✗ ${name}: ${e.message.split('\n')[0]}`);
      failed = true;
    }
    if (errors.length) console.log(`  page errors: ${errors.slice(0, 3).join(' | ')}`);
    await page.close();
  }
} finally {
  await browser.close();
  await server?.close();
}

console.log('\nview              WCAG rules  nodes  best-practice  nodes  review');
for (const r of rows) console.log(`${(r.view + (r.label ? `:${r.label}` : '')).padEnd(18)}${String(r.wcagRules).padStart(10)}${String(r.wcagNodes).padStart(7)}${String(r.bpRules).padStart(15)}${String(r.bpNodes).padStart(7)}${String(r.incomplete).padStart(8)}`);
const json = opt('json');
if (json) {
  mkdirSync(dirname(resolve(ROOT, json)), { recursive: true });
  writeFileSync(resolve(ROOT, json), JSON.stringify({ rows, results: full }, null, 1));
}
const total = rows.reduce((a, r) => a + r.wcagRules + r.bpRules, 0);
if ((total > 0 || failed) && !flag('no-fail')) process.exitCode = 1;
