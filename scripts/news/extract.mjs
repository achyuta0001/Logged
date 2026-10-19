// Step 4 of the news pipeline: specific places named in flood sentences, located.
//
//   node scripts/news/extract.mjs
//
// For every cached article (scripts/news/fetch.mjs) that is about Bengaluru, finds place names that
// end in a type word (underpass, junction, circle, road, main, cross, layout, flyover...) inside a
// sentence with a flood word (src/commute/spots.ts extractMentions), then locates each name:
//   1. the OSM gazetteer (scripts/news/gazetteer.mjs), with a few spelling variants
//      ("Silk Board junction" -> "Silk Board"; an underpass is snapped to the nearest mapped tunnel
//      within 400 m of the junction it is named after);
//   2. otherwise Nominatim, bounded to Bengaluru Urban, 1 request/s, cached, custom User-Agent.
// A hit is kept only when it is specific (acceptHit: inside the district, a road no longer than
// 3 km, a name not used in several places). Output .cache/news/mentions.json (local only).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acceptHit, BLR_BBOX, coreTokens, displayName, extractMentions, kindOf, metres, nameSimilar, normName, summarize } from '../../src/commute/spots.ts';

const UA = 'Logged flood explorer (github.com/achyuta0001/Logged)';
const NOM_DIR = '.cache/news/nominatim';
mkdirSync(NOM_DIR, { recursive: true });
const gaz = JSON.parse(readFileSync('.cache/news/gazetteer.json', 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash('sha1').update(s).digest('hex');

const TYPE_TAIL = /\s(underpass|subway|rub|junction|circle|signal|chowk|road|main road|main|street|cross|layout|flyover|bridge)$/;

function fromGazetteer(key) {
  const g = gaz.names[key];
  if (!g?.length) return null;
  let spread = 0;
  for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) spread = Math.max(spread, metres(g[i].coord, g[j].coord));
  const top = [...g].sort((a, b) => b.n - a.n)[0];
  return { coord: top.coord, kind: top.kind, lengthM: g.length === 1 ? top.lengthM : top.lengthM, spreadM: spread, via: 'osm' };
}

function nearestTunnel(c, maxM = 400) {
  let best = null, bd = maxM;
  for (const t of gaz.tunnels) {
    if (Math.abs(t[0] - c[0]) > 0.005 || Math.abs(t[1] - c[1]) > 0.005) continue;
    const d = metres(t, c);
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  return best;
}

function gazetteer(phrase, kind) {
  const n = normName(phrase);
  const core = n.replace(TYPE_TAIL, '').trim();
  const variants = [n];
  if (kind === 'junction' || kind === 'other') variants.push(`${core} junction`, `${core} circle`, `${core} signal`, core, `central ${core}`);
  if (kind === 'underpass') variants.push(`${core} underpass`, `${core} railway underpass`, `${core} circle`, `${core} junction`, core);
  if (kind === 'road') variants.push(n.replace(/ main road$/, ' road'), n.replace(/ road$/, ' main road'), n.replace(/ main$/, ' main road'), n.replace(/ cross$/, ' cross road'));
  if (kind === 'layout') variants.push(`${core} layout`, core);
  for (const v of variants) {
    if (!v || coreTokens(v).length === 0) continue;
    const hit = fromGazetteer(v);
    if (!hit) continue;
    if (kind === 'underpass' && hit.kind !== 'underpass') {
      const t = nearestTunnel(hit.coord);
      if (t) return { ...hit, coord: t, kind: 'underpass' };
    }
    return hit;
  }
  return null;
}

let lastNom = 0;
async function nominatim(phrase) {
  const q = `${phrase}, Bengaluru`;
  const file = join(NOM_DIR, `${sha(q)}.json`);
  let res;
  if (existsSync(file)) res = JSON.parse(readFileSync(file, 'utf8'));
  else {
    const wait = lastNom + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastNom = Date.now();
    const [w, s, e, n] = BLR_BBOX;
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3&countrycodes=in&bounded=1&viewbox=${w},${n},${e},${s}&q=${encodeURIComponent(q)}`;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
      res = r.ok ? await r.json() : [];
    } catch {
      return null;
    }
    writeFileSync(file, JSON.stringify(res));
  }
  for (const r of res) {
    const name = r.name || String(r.display_name).split(',')[0];
    if (!nameSimilar(name, phrase)) continue;
    const coord = [Number(r.lon), Number(r.lat)];
    const bb = (r.boundingbox ?? []).map(Number);
    const lengthM = r.category === 'highway' || r.class === 'highway' ? metres([bb[2], bb[0]], [bb[3], bb[1]]) : undefined;
    return { coord, kind: kindOf(name) ?? undefined, lengthM, spreadM: 0, via: 'nominatim' };
  }
  return null;
}

// ---------------------------------------------------------------- run
const PAGES = '.cache/news/pages';
const gdeltDates = new Map();
if (existsSync('.cache/news/articles.json')) for (const a of JSON.parse(readFileSync('.cache/news/articles.json', 'utf8'))) gdeltDates.set(a.url, a.date);
const pages = readdirSync(PAGES).map((f) => JSON.parse(readFileSync(join(PAGES, f), 'utf8'))).filter((p) => p.status === 'ok');
const cityRe = /\b(bengaluru|bangalore|bbmp|b'luru)\b/gi;
const otherRe = /\b(mumbai|chennai|hyderabad|delhi|kolkata|pune|gurugram|gurgaon|kochi|mysuru|mangaluru)\b/gi;
const out = [];
const cache = new Map();
let articles = 0, rejected = 0;
const rejects = [];
for (const p of pages) {
  const city = (p.text.match(cityRe) ?? []).length + (p.title.match(cityRe) ?? []).length * 2;
  const other = (p.text.match(otherRe) ?? []).length;
  if (city < 2 || other > city) continue;
  const date = p.date || gdeltDates.get(p.url) || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
  articles++;
  // some cached bodies keep HTML tag names as words ("/p . p", "br /"): they end a sentence
  const text = p.text.replace(/\s+(?:br\s*\/|\/p|\/strong|\/em|\/a|\/li|\/h\d)(?:\s+\.)?(?:\s+(?:p|strong|em|li))?(?=\s)/g, '.\n');
  for (const m of extractMentions(text)) {
    const key = `${m.kind}|${normName(m.phrase)}`;
    // roads are only taken from the gazetteer: it knows the whole road's length, Nominatim one segment
    if (!cache.has(key)) cache.set(key, gazetteer(m.phrase, m.kind) ?? (m.kind === 'road' ? null : await nominatim(m.phrase)));
    const hit = cache.get(key);
    if (!acceptHit(m.phrase, hit)) {
      rejected++;
      rejects.push(`${m.phrase} [${m.kind}] ${hit ? `len ${Math.round(hit.lengthM ?? -1)} spread ${Math.round(hit.spreadM ?? 0)} ${hit.via}` : 'not found'}`);
      continue;
    }
    const name = displayName(m.phrase);
    out.push({
      name,
      kind: m.kind,
      coord: hit.coord.map((v) => Math.round(v * 1e5) / 1e5),
      via: hit.via,
      report: { date, url: p.url, outlet: new URL(p.url).hostname.replace(/^www\./, ''), summary: summarize(name, m.kind, m.flood, m.sentence) },
      sentence: m.sentence,
    });
  }
}
writeFileSync('.cache/news/mentions.json', JSON.stringify(out, null, 1));
writeFileSync('.cache/news/rejected.txt', rejects.sort().join('\n'));
console.log(`${pages.length} pages ok, ${articles} about Bengaluru with a date; ${out.length} located mentions kept, ${rejected} rejected (not specific, ambiguous, too long or not found)`);
