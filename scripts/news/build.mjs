// Step 5 of the news pipeline: merge located mentions into spots and write public/data/news-spots.json.
//
//   node scripts/news/build.mjs [--drop id1,id2]   (ids found wrong in the spot-check)
//   node scripts/news/build.mjs --check 15         (prints N random spots with the sentence each came from)
//
// Mentions of one place (within 150 m and a similar name) become one spot; `count` is the number of
// distinct flood days reported (dates within 2 days count once). Sourced, hand-curated spots from
// public/data/hotspots-city.json (or scripts/data/hotspots-blr.json) are merged by proximity: their
// events add to a nearby spot's reports, or become a spot of their own. That file is kept as it is.
// The output holds facts only: place, position, dates, links, outlet and our own <= 15-word summary.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dedupeSpots, displayName, eventCount, kindOf, metres, nameSimilar } from '../../src/commute/spots.ts';

const arg = (k) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const mentions = JSON.parse(readFileSync('.cache/news/mentions.json', 'utf8'));

if (arg('--check')) {
  // a reproducible random sample: re-read each source sentence by hand and judge it
  let seed = 20261019;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const spots = JSON.parse(readFileSync('public/data/news-spots.json', 'utf8')).spots;
  const pick = [...spots].map((s) => [rnd(), s]).sort((a, b) => a[0] - b[0]).slice(0, Number(arg('--check'))).map((x) => x[1]);
  for (const s of pick) {
    console.log(`\n## ${s.id}  ${s.name} [${s.kind}] ${s.coord}  count ${s.count}`);
    for (const r of s.reports.slice(0, 2)) {
      const m = mentions.find((x) => x.report.url === r.url && nameSimilar(x.name, s.name));
      console.log(`  ${r.date} ${r.url}\n    ${m ? m.sentence.slice(0, 400) : '(curated report)'}`);
    }
  }
  process.exit(0);
}

const drop = new Set((arg('--drop') ?? '').split(',').filter(Boolean));
let spots = dedupeSpots(mentions.map((m) => ({ name: m.name, kind: m.kind, coord: m.coord, report: m.report })), 150);

// merge the hand-curated, sourced spots
const curatedFile = existsSync('public/data/hotspots-city.json') ? 'public/data/hotspots-city.json' : 'scripts/data/hotspots-blr.json';
const raw = JSON.parse(readFileSync(curatedFile, 'utf8'));
const curated = Array.isArray(raw) ? raw : raw.hotspots ?? [];
let merged = 0, added = 0;
const words15 = (s) => s.split(/\s+/).slice(0, 15).join(' ');
for (const h of curated) {
  const reports = (h.events ?? [])
    .filter((e) => /^https?:\/\//.test(e.source ?? '') && /^\d{4}/.test(e.date ?? ''))
    .map((e) => ({ date: e.date, url: e.source, outlet: new URL(e.source).hostname.replace(/^www\./, ''), summary: `Flooding reported at ${words15(displayName(h.name.split(/[,(/]/)[0].trim()))}.`.split(/\s+/).slice(0, 15).join(' ') }));
  if (!reports.length) continue;
  const near = spots.filter((s) => metres(s.coord, h.coord) <= 300 && (nameSimilar(s.name, h.name) || metres(s.coord, h.coord) <= 150)).sort((a, b) => metres(a.coord, h.coord) - metres(b.coord, h.coord))[0];
  if (near) {
    for (const r of reports) if (!near.reports.some((x) => x.url === r.url)) near.reports.push(r);
    merged++;
  } else {
    const name = displayName(h.name.split(/[,(/]/)[0].trim());
    spots.push({ id: '', name, coord: h.coord, kind: kindOf(name) ?? 'other', reports, count: 0, firstYear: 0, lastYear: 0 });
    added++;
  }
}
for (const s of spots) {
  s.reports.sort((a, b) => b.date.localeCompare(a.date));
  s.count = eventCount(s.reports.map((r) => r.date));
  const years = s.reports.map((r) => Number(r.date.slice(0, 4)));
  s.firstYear = Math.min(...years);
  s.lastYear = Math.max(...years);
  if (!s.id) s.id = `${s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${s.coord[0].toFixed(3)}-${s.coord[1].toFixed(3)}`;
}
spots = spots.filter((s) => !drop.has(s.id)).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

const out = {
  about:
    'Flood spots in Bengaluru named in news reports (scripts/news/). Each report links its source; summaries are our own words, at most 15 words, never article text. Positions come from OpenStreetMap names (ODbL) or Nominatim. count = distinct flood days reported (dates within 2 days count once). Coverage follows the news: busy roads are over-represented.',
  generated: new Date().toISOString().slice(0, 10),
  sources: { discovery: ['GDELT DOC 2.0 API (when not rate limited)', 'web search (queries in scripts/news/web-search-urls.json)'], curated: curatedFile },
  spots,
};
writeFileSync('public/data/news-spots.json', JSON.stringify(out, null, 1).replace(/\[\n\s+(-?[\d.]+),\n\s+(-?[\d.]+)\n\s+\]/g, '[$1, $2]'));
console.log(`${mentions.length} mentions -> ${spots.length} spots (${merged} curated merged, ${added} curated added, ${drop.size} dropped) -> public/data/news-spots.json`);
