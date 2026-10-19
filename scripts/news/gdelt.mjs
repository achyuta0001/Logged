// Step 1 of the news pipeline: discover Bengaluru flood articles with the GDELT DOC 2.0 API
// (free, no key; full-text search over world news, English coverage from 2017).
//
//   node scripts/news/gdelt.mjs [--from 2017-01] [--to 2026-09]
//
// One query per 3-month window, sorted by relevance (the 250-record cap then keeps the most
// on-topic articles; a full-text "Bangalore AND flood" search sorted by date fills up with noise).
// Polite: one request every 12 s, long back-off on HTTP 429, and a window GDELT keeps refusing is
// logged and skipped, never hammered. Raw responses are cached in .cache/news/gdelt/ (a cached
// window is never re-fetched); the merged, de-duplicated article list goes to .cache/news/articles.json.
// Stores only what GDELT returns: url, title, date, outlet domain.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const CACHE = '.cache/news/gdelt';
const OUT = '.cache/news/articles.json';
const API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const QUERY =
  '("Bengaluru rain" OR "Bengaluru rains" OR "Bangalore rain" OR "Bangalore rains" OR "Bengaluru flood" OR "Bengaluru floods" OR "Bangalore flood" OR "Bangalore floods") (waterlogging OR waterlogged OR flooded OR inundated OR underpass OR submerged) sourcelang:english';
const GAP_MS = 12000;
const MAX_TRIES = 6;
/** cache files are keyed by the query too, so a changed query never reuses old answers */
const QKEY = createHash('sha1').update(QUERY).digest('hex').slice(0, 8);

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const from = arg('--from', '2017-01');
const to = arg('--to', '2026-09');
mkdirSync(CACHE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = (d) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
let lastAt = 0;

async function query(start, end) {
  const key = `${QKEY}-${stamp(start)}-${stamp(end)}`;
  const file = join(CACHE, `${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const url = `${API}?query=${encodeURIComponent(QUERY)}&mode=ArtList&format=json&maxrecords=250&sort=HybridRel&startdatetime=${stamp(start)}&enddatetime=${stamp(end)}`;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const wait = lastAt + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    let res, text;
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'Logged flood explorer (github.com/achyuta0001/Logged)' } });
      text = await res.text();
    } catch (e) {
      console.warn(`  ${key}: ${e.message}, retrying`);
      await sleep(10000 * (attempt + 1));
      continue;
    }
    if (res.status === 429 || /limit requests/i.test(text.slice(0, 200))) {
      const back = 30000 * 2 ** Math.min(attempt, 2);
      console.warn(`  ${key}: rate limited, waiting ${back / 1000} s`);
      await sleep(back);
      continue;
    }
    let body;
    try {
      body = text.trim() ? JSON.parse(text) : { articles: [] };
    } catch {
      console.warn(`  ${key}: not JSON (${text.slice(0, 120)})`);
      body = { articles: [], error: text.slice(0, 300) };
    }
    const out = { start: start.toISOString(), end: end.toISOString(), query: QUERY, fetchedAt: new Date().toISOString(), articles: body.articles ?? [] };
    if (!body.error) writeFileSync(file, JSON.stringify(out));
    return out;
  }
  console.warn(`  ${key}: GDELT kept refusing, skipped (re-run later; cached windows are not re-fetched)`);
  return { articles: [], skipped: true };
}

async function window(start, end) {
  const r = await query(start, end);
  console.log(`${start.toISOString().slice(0, 10)} .. ${end.toISOString().slice(0, 10)}: ${r.skipped ? 'skipped' : r.articles.length}`);
  return r.articles;
}

const [fy, fm] = from.split('-').map(Number);
const [ty, tm] = to.split('-').map(Number);
const all = [];
for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m += 3) {
  while (m > 12) {
    m -= 12;
    y++;
  }
  if (y > ty || (y === ty && m > tm)) break;
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m - 1 + 3, 1) - 1000);
  all.push(...(await window(start, end)));
}

// merge with anything cached from earlier runs, dedupe by url
for (const f of readdirSync(CACHE).filter((f) => f.startsWith(QKEY))) {
  try {
    all.push(...JSON.parse(readFileSync(join(CACHE, f), 'utf8')).articles);
  } catch {
    /* skip a broken cache file */
  }
}
const byUrl = new Map();
for (const a of all) {
  if (!a?.url || byUrl.has(a.url)) continue;
  byUrl.set(a.url, { url: a.url, title: a.title ?? '', date: (a.seendate ?? '').slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'), outlet: a.domain ?? '' });
}
const list = [...byUrl.values()].sort((a, b) => a.date.localeCompare(b.date));
writeFileSync(OUT, JSON.stringify(list, null, 0));
console.log(`${list.length} unique articles -> ${OUT}`);
