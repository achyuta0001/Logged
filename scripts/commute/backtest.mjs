#!/usr/bin/env node
// Backtest of the commute risk engine on past flood days: backtest/REPORT.md.
//
//   node scripts/commute/backtest.mjs            (archive requests cached in .cache/commute/archive/)
//
// What it does
//   Days: every full date (YYYY-MM-DD) on which a hotspot in public/data/commute/hotspots.geojson has
//   a sourced report ("report days"), plus one control day per report day: the same date 9 days later
//   when no report falls within 3 days of it (same season, nothing reported).
//   Split: report days in date order alternate training / evaluation (held out); a control day goes
//   with its report day. The only thing fitted is THRESHOLD_SCALE (one multiplier on every type
//   threshold), picked on the training days by the best critical success index; all other numbers
//   are config.ts as committed.
//   Rain: Open-Meteo historical archive (reanalysis), hourly, at hotspot clusters of 0.1 deg (the
//   archive's cells are 9-25 km), one multi-location request per year.
//   A hotspot-day is predicted when any 30-minute bucket from 12:00 IST the day before to midnight at
//   the end of the day is likely or severe (articles describe the previous evening or night), and
//   reported when the hotspot has a report dated that day.
//   Gauge variant: on the four storms in src/weather.ts HISTORICAL_EVENTS with a reported gauge total,
//   the archive hours are scaled so each storm totals the gauge reading (our adjustment, as in the app).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hotspotOutlook, trackFromSums } from '../../src/commute/risk.ts';
import { BUCKET_MS, LEVEL_FROM, SCORE, THRESHOLD_SCALE, TYPE_THRESHOLD_MMHR } from '../../src/commute/config.ts';
import { HISTORICAL_EVENTS, scaleToTotal } from '../../src/weather.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = path.join(ROOT, '.cache', 'commute', 'archive');
const OUT = path.join(ROOT, 'backtest', 'REPORT.md');
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const H = 3600e3, DAY = 24 * H, IST = 5.5 * H;
const CLUSTER_DEG = 0.1;
const SCALES = [0.25, 0.35, 0.5, 0.7, 1, 1.4, 2];
const TODAY = new Date().toISOString().slice(0, 10);
const log = (...a) => console.log('[backtest]', ...a);

const istMidnight = (d) => Date.parse(`${d}T00:00:00Z`) - IST;
const addDays = (d, k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * DAY).toISOString().slice(0, 10);
const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)} %` : '–');

// ------------------------------------------------------------------ inputs

const fc = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'commute', 'hotspots.geojson'), 'utf8'));
const hotspots = fc.features.map((f) => f.properties);
const reportedOn = new Map(); // date -> Set(id)
for (const h of hotspots)
  for (const d of h.dates ?? [])
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d <= TODAY) {
      if (!reportedOn.has(d)) reportedOn.set(d, new Set());
      reportedOn.get(d).add(h.id);
    }
const reportDays = [...reportedOn.keys()].sort();
const near = (d, k) => reportDays.some((r) => Math.abs(Date.parse(r) - Date.parse(d)) <= k * DAY);
const days = [];
reportDays.forEach((d, i) => {
  const split = i % 2 === 0 ? 'train' : 'test';
  days.push({ date: d, kind: 'report', split });
  const c = addDays(d, 9);
  if (c <= TODAY && !near(c, 3) && !days.some((x) => x.date === c)) days.push({ date: c, kind: 'control', split });
});
log(`${reportDays.length} report days, ${days.length - reportDays.length} control days, ${hotspots.length} hotspots`);

// clusters
const clusters = new Map();
for (const h of hotspots) {
  const key = `${Math.round(h.coord[0] / CLUSTER_DEG)}:${Math.round(h.coord[1] / CLUSTER_DEG)}`;
  if (!clusters.has(key)) clusters.set(key, { key, ids: [], x: 0, y: 0 });
  const c = clusters.get(key);
  c.ids.push(h.id);
  c.x += h.coord[0];
  c.y += h.coord[1];
}
const cl = [...clusters.values()].map((c) => ({ ...c, lon: +(c.x / c.ids.length).toFixed(3), lat: +(c.y / c.ids.length).toFixed(3) }));
const clusterOf = new Map(cl.flatMap((c, i) => c.ids.map((id) => [id, i])));
log(`${cl.length} archive points (${CLUSTER_DEG} deg clusters)`);

// ------------------------------------------------------------------ archive rain (cached, one request per year)

async function archiveYear(year, start, end) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${year}-${start}-${end}-${cl.map((c) => `${c.lat},${c.lon}`).join(';').length}-${cl.length}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const url = `${ARCHIVE}?latitude=${cl.map((c) => c.lat).join(',')}&longitude=${cl.map((c) => c.lon).join(',')}&start_date=${start}&end_date=${end}&hourly=precipitation&timezone=GMT&timeformat=unixtime`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    const body = await res.json().catch(() => null);
    if (res.ok && body && !body.error) {
      const arr = Array.isArray(body) ? body : [body];
      const out = arr.map((b) => ({ time: b.hourly.time, mm: b.hourly.precipitation }));
      fs.writeFileSync(file, JSON.stringify(out));
      await new Promise((r) => setTimeout(r, 1500));
      return out;
    }
    log(`archive ${year}: ${body?.reason ?? res.status}, retrying`);
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
  }
  throw new Error(`archive ${year} failed`);
}

const byYear = new Map();
for (const d of days) {
  const y = d.date.slice(0, 4);
  const [a, b] = byYear.get(y) ?? [d.date, d.date];
  byYear.set(y, [d.date < a ? d.date : a, d.date > b ? d.date : b]);
}
const rain = new Map(); // cluster index -> { times(ms end-stamped), mm }
for (const [y, [a, b]] of [...byYear.entries()].sort()) {
  const start = addDays(a, -3), end = addDays(b, 1) > TODAY ? TODAY : addDays(b, 1);
  const arr = await archiveYear(y, start, end);
  arr.forEach((loc, i) => {
    const r = rain.get(i) ?? { times: [], mm: [] };
    // Open-Meteo hourly precipitation is the sum over the hour ENDING at the stamp
    for (let k = 0; k < loc.time.length; k++) {
      r.times.push(loc.time[k] * 1000);
      r.mm.push(loc.mm[k]);
    }
    rain.set(i, r);
  });
  log(`archive ${y}: ${start}..${end}`);
}

const GAUGE = HISTORICAL_EVENTS.filter((e) => e.scaled).map((e) => ({ id: e.id, start: e.start, end: e.end, t0: istMidnight(e.start), t1: istMidnight(e.end) + DAY, mm: e.gaugeMm, gauge: e.gauge }));
/** per gauge storm and cluster: stamp -> archive hour scaled so the whole storm (start..end, IST days) totals the gauge reading */
const scaledRain = new Map();
for (const g of GAUGE)
  for (const [i, r] of rain) {
    const idx = r.times.map((t, k) => (t > g.t0 && t <= g.t1 ? k : -1)).filter((k) => k >= 0);
    const scaled = scaleToTotal(idx.map((k) => r.mm[k] ?? 0), g.mm);
    scaledRain.set(`${g.id}:${i}`, new Map(idx.map((k, j) => [r.times[k], scaled[j]])));
  }

/** rain at cluster i over (t0, t1] as end-stamped hourly sums; with `gauge`, that storm's hours are the scaled ones */
function series(i, t0, t1, gauge) {
  const r = rain.get(i);
  const sc = gauge ? scaledRain.get(`${gauge.id}:${i}`) : null;
  const times = [], mm = [];
  for (let k = 0; k < r.times.length; k++)
    if (r.times[k] > t0 && r.times[k] <= t1) {
      times.push(r.times[k]);
      mm.push(sc?.has(r.times[k]) ? sc.get(r.times[k]) : (r.mm[k] ?? 0));
    }
  return { times, mm };
}
const gaugeFor = (date) => GAUGE.find((g) => date >= g.start && date <= g.end) ?? null;

// ------------------------------------------------------------------ predictions

/** max level per hotspot for one day; window 12:00 IST the day before -> midnight ending the day */
function predictDay(date, scale, gauge = null) {
  const w0 = istMidnight(date) - 12 * H, w1 = istMidnight(date) + DAY;
  const out = new Map();
  const tracks = new Map();
  for (const h of hotspots) {
    const i = clusterOf.get(h.id);
    if (!tracks.has(i)) {
      const s = series(i, w0 - 26 * H, w1, gauge);
      tracks.set(i, { tr: trackFromSums(s.times, s.mm, H), peak: Math.max(0, ...s.mm.slice(-36)), total: s.mm.slice(-36).reduce((a, b) => a + (b ?? 0), 0) });
    }
    const { tr } = tracks.get(i);
    const o = hotspotOutlook(h, tr, { from: w0, to: w1, scale });
    out.set(h.id, o.buckets.some((b) => b.level === 'likely' || b.level === 'severe'));
  }
  const rainStats = [...tracks.values()];
  return { pred: out, peak: Math.max(...rainStats.map((x) => x.peak)), total: Math.max(...rainStats.map((x) => x.total)) };
}

function score(dayList, scale, opts = {}) {
  const cm = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const byType = {};
  const perDay = [];
  for (const d of dayList) {
    const g = opts.gauge ? gaugeFor(d.date) : null;
    if (opts.gauge && !g) continue;
    const { pred, peak, total } = predictDay(d.date, scale, g);
    const rep = reportedOn.get(d.date) ?? new Set();
    let dayHits = 0, dayPred = 0;
    for (const h of hotspots) {
      const p = pred.get(h.id), r = d.kind === 'report' && rep.has(h.id);
      const k = p && r ? 'tp' : p ? 'fp' : r ? 'fn' : 'tn';
      cm[k]++;
      (byType[h.type] ??= { tp: 0, fp: 0, fn: 0, tn: 0 })[k]++;
      if (p) dayPred++;
      if (p && r) dayHits++;
    }
    perDay.push({ ...d, reported: d.kind === 'report' ? rep.size : 0, predicted: dayPred, hits: dayHits, peak, total, gauge: g?.id });
  }
  return { cm, byType, perDay };
}

const metrics = ({ tp, fp, fn, tn }) => ({
  precision: tp / (tp + fp),
  recall: tp / (tp + fn),
  far: fp / (fp + tn),
  csi: tp / (tp + fp + fn),
  n: tp + fp + fn + tn,
  tp, fp, fn, tn,
});

const train = days.filter((d) => d.split === 'train');
const test = days.filter((d) => d.split === 'test');
const fit = SCALES.map((s) => ({ s, m: metrics(score(train, s).cm) }));
const best = [...fit].sort((a, b) => (b.m.csi || 0) - (a.m.csi || 0) || Math.abs(a.s - 1) - Math.abs(b.s - 1))[0];
log(`training: best threshold scale ${best.s} (CSI ${best.m.csi.toFixed(3)})`);
const evalAt = (s, dl = test, opts) => score(dl, s, opts);
const T_fit = evalAt(best.s);
const T_one = evalAt(1);
const G_raw = evalAt(best.s, days, { gauge: true });
const gaugeDays = G_raw.perDay.map((d) => d.date);
// gauge variant: same days, scaled rain
function scoreGauge(scale) {
  const cm = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const perDay = [];
  for (const d of days) {
    const g = gaugeFor(d.date);
    if (!g) continue;
    const { pred, peak, total } = predictDay(d.date, scale, g);
    const rep = reportedOn.get(d.date) ?? new Set();
    let dp = 0, dh = 0;
    for (const h of hotspots) {
      const p = pred.get(h.id), r = d.kind === 'report' && rep.has(h.id);
      cm[p && r ? 'tp' : p ? 'fp' : r ? 'fn' : 'tn']++;
      if (p) dp++;
      if (p && r) dh++;
    }
    perDay.push({ ...d, reported: rep.size, predicted: dp, hits: dh, peak, total, gauge: g.id });
  }
  return { cm, perDay };
}
function scoreRawOn(dates, scale) {
  const cm = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const perDay = [];
  for (const d of days.filter((x) => dates.includes(x.date))) {
    const { pred, peak, total } = predictDay(d.date, scale, null);
    const rep = reportedOn.get(d.date) ?? new Set();
    let dp = 0, dh = 0;
    for (const h of hotspots) {
      const p = pred.get(h.id), r = d.kind === 'report' && rep.has(h.id);
      cm[p && r ? 'tp' : p ? 'fp' : r ? 'fn' : 'tn']++;
      if (p) dp++;
      if (p && r) dh++;
    }
    perDay.push({ ...d, reported: rep.size, predicted: dp, hits: dh, peak, total });
  }
  return { cm, perDay };
}
const gaugeScaled = scoreGauge(best.s);
const gaugeRaw = scoreRawOn(gaugeDays, best.s);
const gaugeScaledOne = scoreGauge(1);
/** a-priori archive-to-gauge factor: the archive holds 2.5-7x less rain than the gauges (PROGRESS.md); ~4 is their geometric mean */
const GAUGE_FACTOR = 4;
const gaugeScaledX4 = scoreGauge(best.s * GAUGE_FACTOR);

/** day level: does the engine tell report days from control days at all? */
function dayLevel(res, kind) {
  const ds = res.perDay.filter((d) => d.kind === kind);
  const any = ds.filter((d) => d.predicted > 0).length;
  const hit = ds.filter((d) => d.hits > 0).length;
  const mean = ds.reduce((a, d) => a + d.predicted, 0) / (ds.length || 1);
  const wet = ds.reduce((a, d) => a + d.total, 0) / (ds.length || 1);
  return { n: ds.length, any, hit, mean, wet };
}

// ------------------------------------------------------------------ report

const row = (name, m) => `| ${name} | ${m.n} | ${m.tp} | ${m.fp} | ${m.fn} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.far)} | ${Number.isFinite(m.csi) ? m.csi.toFixed(3) : '–'} |`;
const head = '| | hotspot-days | hits | false alarms | misses | precision | recall | false-alarm rate | CSI |\n|---|---|---|---|---|---|---|---|---|';
function split(res, kind) {
  // recompute the matrix for one kind of day (report / control)
  const cm = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const d of res.perDay.filter((x) => x.kind === kind)) {
    cm.tp += d.hits;
    cm.fp += d.predicted - d.hits;
    cm.fn += d.reported - d.hits;
    cm.tn += hotspots.length - d.predicted - (d.reported - d.hits);
  }
  return metrics(cm);
}
const typeRows = (res) =>
  Object.entries(res.byType)
    .sort()
    .map(([t, cm]) => row(t, metrics(cm)))
    .join('\n');
const dayRows = (res) =>
  res.perDay
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => `| ${d.date} | ${d.kind} | ${d.split} | ${d.total.toFixed(1)} | ${d.peak.toFixed(1)} | ${d.reported} | ${d.predicted} | ${d.hits} |`)
    .join('\n');

const mT = metrics(T_fit.cm), mT1 = metrics(T_one.cm);
const lines = [
  '# Commute risk engine: backtest',
  '',
  `Generated ${TODAY} by \`node scripts/commute/backtest.mjs\` from \`public/data/commute/hotspots.geojson\` (${hotspots.length} hotspots) and the engine settings in \`src/commute/config.ts\`. Rain: Open-Meteo historical archive (reanalysis, CC BY 4.0).`,
  '',
  '## Read this first',
  '',
  '- **The rain is far too low.** The archive is a reanalysis averaged over 9–25 km cells, not a rain gauge. On Bengaluru flood days it holds 2.5–7 times less rain than the gauges the reports quote, and wettest hours of 4–12 mm instead of the 30–60 mm/h the reports describe (PROGRESS.md, "Real storms"). Several parts of the city share one cell, so every hotspot in a cell gets the same rain. The forecast the app uses is the same kind of gridded model output (its points for Bengaluru are ~9 km apart), which is why the thresholds are in model rain, not gauge rain.',
  '- **The reports are not a list of floods.** "Reported" means a sourced news article names that hotspot on that date. Most waterlogging is never reported, busy and central roads are reported more than the outskirts, and an article usually names a handful of places for a city-wide storm. Many "false alarms" below are probably unreported floods; many "misses" are storms the archive barely shows. Article dates can trail the rain by a day.',
  '- **Few positives.** ' + `${[...reportedOn.values()].reduce((n, s) => n + s.size, 0)} hotspot-days with a report across ${reportDays.length} report days.` + ' One storm more or less changes these numbers a lot.',
  '- **What was fitted.** Only one number: a multiplier on every type threshold (`THRESHOLD_SCALE`), chosen on the training days by the best critical success index (CSI = hits / (hits + misses + false alarms)). Weights, level bands and type thresholds are as committed and were not tuned on these days. The evaluation days were not used for anything.',
  '',
  '## Set-up',
  '',
  `- **Days:** every date with a sourced report at a hotspot (${reportDays.length} days, ${reportDays[0]} to ${reportDays[reportDays.length - 1]}); month-only dates are left out. Plus ${days.length - reportDays.length} control days: the date 9 days after a report day, when no report falls within 3 days of it.`,
  `- **Split:** report days in date order alternate training / evaluation (${train.filter((d) => d.kind === 'report').length} / ${test.filter((d) => d.kind === 'report').length}); a control day goes with its report day.`,
  '- **Prediction:** a hotspot-day is predicted when any 30-minute bucket from 12:00 IST the day before to the end of the day is *likely* or *severe* (reports describe the evening or night before as often as the day itself).',
  `- **Rain:** hourly archive precipitation at ${cl.length} points (hotspots grouped in ${CLUSTER_DEG}° cells), the 24 h before each window for the antecedent term.`,
  `- **Engine:** type thresholds ${Object.entries(TYPE_THRESHOLD_MMHR).map(([k, v]) => `${k} ${v}`).join(', ')} mm/h; level bands watch ${LEVEL_FROM.watch}, likely ${LEVEL_FROM.likely}, severe ${LEVEL_FROM.severe}; persist ${SCORE.persist}, antecedent ${SCORE.antecedentW} at ${SCORE.antecedentSatMm} mm, lowness ${SCORE.lownessW}, history ${SCORE.historyW} at ${SCORE.historySatDays} days.`,
  '',
  '## Threshold scale (training days only)',
  '',
  '| scale | precision | recall | false-alarm rate | CSI |',
  '|---|---|---|---|---|',
  ...fit.map(({ s, m }) => `| ${s}${s === best.s ? ' (chosen)' : ''} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.far)} | ${Number.isFinite(m.csi) ? m.csi.toFixed(3) : '–'} |`),
  '',
  `Chosen: **${best.s}**, so an underpass is flagged from about ${(TYPE_THRESHOLD_MMHR.underpass * best.s).toFixed(1)} mm/h of archive rain and a road from ${(TYPE_THRESHOLD_MMHR.road * best.s).toFixed(1)} mm/h, before the lowness, history and wet-ground terms lower that further.${best.s !== THRESHOLD_SCALE ? ` \`config.ts\` has THRESHOLD_SCALE = ${THRESHOLD_SCALE}; set it to ${best.s} to ship this choice.` : ' `config.ts` ships this value.'}`,
  '',
  '## Held-out evaluation days',
  '',
  head,
  row(`all days, scale ${best.s}`, mT),
  row(`report days only, scale ${best.s}`, split(T_fit, 'report')),
  row(`control days only, scale ${best.s}`, split(T_fit, 'control')),
  row('all days, scale 1 (no fitting)', mT1),
  '',
  'Day level, held-out days: how often the engine flags anything, and how many hotspots, on days with and without reports.',
  '',
  '| days | n | mean archive rain in the 36 h window, wettest point (mm) | days with any hotspot likely or severe | mean hotspots flagged | days where a reported hotspot was flagged |',
  '|---|---|---|---|---|---|',
  ...['report', 'control'].map((k) => {
    const x = dayLevel(T_fit, k);
    return `| ${k} | ${x.n} | ${x.wet.toFixed(1)} | ${x.any} (${pct(x.any / x.n)}) | ${x.mean.toFixed(1)} of ${hotspots.length} | ${k === 'report' ? `${x.hit} (${pct(x.hit / x.n)})` : '–'} |`;
  }),
  '',
  `Per type, held-out days, scale ${best.s}:`,
  '',
  head,
  typeRows(T_fit),
  '',
  '## Gauge-scaled variant',
  '',
  `The four storms in \`src/weather.ts\` with a reported gauge total (${GAUGE.map((g) => `${g.start}..${g.end} ${g.mm} mm ${g.gauge}`).join('; ')}): the archive hours of each storm are scaled so the storm totals the gauge reading, at every hotspot (one gauge stands for the whole city, and the hours keep the archive's smeared shape: our adjustment, not observed rain). Same days, all splits (${gaugeDays.length} days):`,
  '',
  head,
  row(`archive rain, scale ${best.s}`, metrics(gaugeRaw.cm)),
  row(`gauge-scaled rain, scale ${best.s}`, metrics(gaugeScaled.cm)),
  row('gauge-scaled rain, scale 1', metrics(gaugeScaledOne.cm)),
  row(`gauge-scaled rain, thresholds x ${GAUGE_FACTOR} (archive-to-gauge factor, not fitted)`, metrics(gaugeScaledX4.cm)),
  '',
  (() => {
    const x4 = metrics(gaugeScaledX4.cm), sc = metrics(gaugeScaled.cm);
    return `The thresholds are in model rain. On rain scaled up to the gauge totals they flag ${pct(sc.recall)} of the reported and ${pct(sc.far)} of the unreported hotspot-days. Raised by the archive-to-gauge factor (${GAUGE_FACTOR}, the middle of the 2.5-7x range, fixed before looking) they flag ${pct(x4.recall)} and ${pct(x4.far)}: on city-wide storm days like these the rule still flags most places, and most of those false alarms are probably unreported floods. These 8 days cannot tell a good rule from a bad one; they show that the rain input, not the rule, sets the miss rate.`;
  })(),
  '',
  '| date | kind | split | archive 36 h max (mm) | wettest hour (mm) | reported | predicted | both | gauge-scaled: predicted | both |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...gaugeRaw.perDay.map((d) => {
    const g = gaugeScaled.perDay.find((x) => x.date === d.date);
    return `| ${d.date} | ${d.kind} | ${d.split} | ${d.total.toFixed(1)} | ${d.peak.toFixed(1)} | ${d.reported} | ${d.predicted} | ${d.hits} | ${g?.predicted ?? '–'} | ${g?.hits ?? '–'} |`;
  }),
  '',
  '## Every day (held-out and training), chosen scale',
  '',
  '"archive 36 h" and "wettest hour" are the wettest archive point in the window. "predicted" = hotspots flagged likely or severe, "both" = flagged and reported.',
  '',
  '| date | kind | split | archive 36 h max (mm) | wettest hour (mm) | reported | predicted | both |',
  '|---|---|---|---|---|---|---|---|',
  dayRows({ perDay: [...score(train, best.s).perDay, ...T_fit.perDay] }),
  '',
  '## What this says',
  '',
  `- On held-out days the engine flags ${pct(mT.recall)} of the reported hotspot-days, and ${pct(mT.precision)} of its flags have a report (false-alarm rate ${pct(mT.far)} of unreported hotspot-days). With archive rain this low, a level from the forecast is a weak signal; treat it as "rain near the level that has flooded this place before", which is how the app words it.`,
  (() => {
    const r = dayLevel(T_fit, 'report'), c = dayLevel(T_fit, 'control');
    return `- Day level: on held-out report days something is flagged on ${pct(r.any / r.n)} of days (${r.mean.toFixed(0)} hotspots on average), on control days on ${pct(c.any / c.n)} (${c.mean.toFixed(0)}). The engine separates storm days from quieter ones, but it flags many more places than the news names, and ${r.n - r.hit} of ${r.n} report days had none of their reported hotspots flagged.`;
  })(),
  '- The gauge-scaled rows show how much of the miss rate is the rain input rather than the rule: with storm totals at gauge level every reported hotspot is flagged, and so is everything else.',
  '- Per-type numbers rest on very few reports each; differences between types are not meaningful yet.',
  '- To do better: an hourly gauge or radar source (KSNDMC telemetry is neither open nor keyless), more dated reports (especially "no flooding" days), and per-hotspot thresholds once a place has several reports with known rain.',
  '',
];
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'));
log(`held-out: precision ${pct(mT.precision)}, recall ${pct(mT.recall)}, FAR ${pct(mT.far)}, CSI ${mT.csi.toFixed(3)} -> ${path.relative(ROOT, OUT)}`);
