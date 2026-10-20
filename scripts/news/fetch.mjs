// Step 3 of the news pipeline: fetch the discovered articles, politely, into a local cache.
//
//   node scripts/news/fetch.mjs
//
// Input: .cache/news/articles.json (GDELT, step 1) and scripts/news/web-search-urls.json.
// Output: .cache/news/pages/<sha1>.json = { url, finalUrl, status, date, title, text } (local cache
// only, never committed; the published file keeps only facts and our own summaries).
// Politeness: robots.txt is honoured (User-agent: * rules), one request per domain every 4 s, at most
// 4 domains at a time, a custom User-Agent, and nothing is fetched twice. Paywalled, blocked or
// empty pages are recorded as skipped.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UA = 'Logged flood explorer (github.com/achyuta0001/Logged)';
const DIR = '.cache/news/pages';
const PER_DOMAIN_MS = 4000;
const PARALLEL = 4;
mkdirSync(DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash('sha1').update(s).digest('hex');

/** AMP and "amp/story" links point at the same article as the canonical page */
export function canonicalUrl(u) {
  let s = u.trim();
  s = s.replace(/\/amp\/story\/(india%2F[^?#]+)/i, (_, p) => `/${decodeURIComponent(p)}`);
  s = s.replace(/\/amp\/story\//, '/');
  s = s.replace(/\/amp\/?$/, '').replace(/\.amp\.html$/, '.html');
  s = s.replace(/^https?:\/\/(?!www\.)(deccanherald|thenewsminute|etvbharat|deccanchronicle)\.com/, 'https://www.$1.com');
  return s;
}

const decode = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;|&mdash;/g, '-')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-z]+;/g, ' ');

/** Article text from <p> blocks (or JSON-LD articleBody), scripts and page chrome removed. */
export function articleText(html) {
  const ld = [...html.matchAll(/"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return '';
    }
  });
  const body = html.replace(/<(script|style|noscript|svg|header|footer|nav|aside|form|figure)\b[\s\S]*?<\/\1>/gi, ' ');
  const ps = [...body.matchAll(/<(p|h1|h2|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
  const text = ps.filter((p) => p.length > 30).join('\n');
  // JSON-LD bodies carry their markup entity-encoded: decode first, then turn tags into breaks
  const fromLd = decode(ld.join('\n')).replace(/<\/(p|li|h\d)>|<br\s*\/?>/gi, '.\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ');
  return fromLd.length > text.length ? fromLd : text;
}

/** Publication date (YYYY-MM-DD) from page metadata, else from the URL. */
export function publishedDate(html, url) {
  const pats = [
    /property=["']article:published_time["'][^>]*content=["'](\d{4}-\d{2}-\d{2})/i,
    /content=["'](\d{4}-\d{2}-\d{2})[^"']*["'][^>]*property=["']article:published_time/i,
    /"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/,
    /itemprop=["']datePublished["'][^>]*content=["'](\d{4}-\d{2}-\d{2})/i,
    /name=["'](?:publish-date|pubdate|publishdate|date)["'][^>]*content=["'](\d{4}-\d{2}-\d{2})/i,
    /"publishedAt"\s*:\s*"(\d{4}-\d{2}-\d{2})/,
    /"published-at"\s*:\s*(\d{12,13})/,
    /"first-published-at"\s*:\s*(\d{12,13})/,
  ];
  for (const re of pats) {
    const m = html.match(re);
    if (!m) continue;
    if (/^\d{12,13}$/.test(m[1])) return new Date(Number(m[1]) + 5.5 * 3600e3).toISOString().slice(0, 10);
    return m[1];
  }
  const u = url.match(/\/(20\d{2})\/(\d{2})\/(\d{2})\//);
  return u ? `${u[1]}-${u[2]}-${u[3]}` : '';
}

// ---------------------------------------------------------------- robots.txt
const robots = new Map();
async function allowed(url) {
  const { origin, pathname } = new URL(url);
  if (!robots.has(origin)) {
    let rules = [];
    try {
      const r = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        let applies = false;
        for (const line of (await r.text()).split(/\r?\n/)) {
          const [k, ...rest] = line.split(':');
          const v = rest.join(':').trim();
          if (/^user-agent$/i.test(k.trim())) applies = v === '*';
          else if (applies && /^disallow$/i.test(k.trim()) && v) rules.push(v);
        }
      }
    } catch {
      rules = [];
    }
    robots.set(origin, rules);
  }
  return !robots.get(origin).some((rule) => {
    const re = new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}`);
    return re.test(pathname);
  });
}

// ---------------------------------------------------------------- run
if (process.argv[1]?.endsWith('fetch.mjs')) {
  const urls = new Set();
  if (existsSync('.cache/news/articles.json')) for (const a of JSON.parse(readFileSync('.cache/news/articles.json', 'utf8'))) urls.add(canonicalUrl(a.url));
  for (const u of JSON.parse(readFileSync('scripts/news/web-search-urls.json', 'utf8')).urls) urls.add(canonicalUrl(u));
  const byDomain = new Map();
  for (const u of urls) {
    const d = new URL(u).hostname.replace(/^www\./, '');
    byDomain.set(d, [...(byDomain.get(d) ?? []), u]);
  }
  let done = 0, ok = 0, skipped = 0;
  const work = async (domain, list) => {
    for (const url of list) {
      const file = join(DIR, `${sha(url)}.json`);
      done++;
      if (existsSync(file)) {
        ok++;
        continue;
      }
      if (!(await allowed(url))) {
        writeFileSync(file, JSON.stringify({ url, status: 'robots', text: '' }));
        skipped++;
        continue;
      }
      let rec;
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
        const html = r.ok ? await r.text() : '';
        const text = articleText(html);
        const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim());
        const paywalled = /subscribe to (continue|read)|premium (story|article)|this content is for subscribers/i.test(html) && text.length < 1500;
        rec = { url, finalUrl: r.url, status: r.ok ? (paywalled ? 'paywall' : text.length < 400 ? 'empty' : 'ok') : `http ${r.status}`, date: publishedDate(html, r.url || url), title, text: paywalled ? '' : text };
      } catch (e) {
        rec = { url, status: `error ${e.message}`, text: '' };
      }
      writeFileSync(file, JSON.stringify(rec));
      if (rec.status === 'ok') ok++;
      else skipped++;
      console.log(`[${done}/${urls.size}] ${rec.status} ${rec.date ?? ''} ${url}`);
      await sleep(PER_DOMAIN_MS);
    }
  };
  const queue = [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length);
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) await work(...job);
    }),
  );
  console.log(`${urls.size} articles: ${ok} cached ok, ${skipped} skipped (robots, paywall, empty or error)`);
}
