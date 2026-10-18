import type { RainSeries } from './types.ts';

/** Show this wherever forecast data is displayed (Open-Meteo free tier licence). */
export const WEATHER_ATTRIBUTION = 'Weather data by Open-Meteo.com (CC BY 4.0)';
export const WEATHER_ATTRIBUTION_URL = 'https://open-meteo.com/';

/** Models requested in the single forecast call; `worst` = hourly max across them. */
export const FORECAST_MODELS = ['best_match', 'ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'] as const;

const CACHE_TTL_MS = 30 * 60 * 1000;
const HOUR = 3600 * 1000;
const IST_OFFSET_MS = 5.5 * HOUR;

interface OpenMeteoHourly {
  time: number[];
  [key: string]: (number | null)[] | number[];
}

export interface ForecastVariants {
  /** Open-Meteo best_match (default blend for the location) */
  best: RainSeries;
  /** hourly maximum across all models that returned data — a pessimistic envelope */
  worst: RainSeries;
  /** models that actually returned precipitation */
  models: string[];
  fetchedAt: number;
}

function cacheGet(key: string, ttlMs = CACHE_TTL_MS): unknown {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as { t: number; data: unknown };
    if (Date.now() - v.t > ttlMs) return undefined;
    return v.data;
  } catch {
    return undefined;
  }
}

function cacheSet(key: string, data: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), data }));
  } catch {
    /* storage unavailable or full: ignore */
  }
}

async function fetchHourly(lat: number, lon: number): Promise<{ hourly: OpenMeteoHourly; fetchedAt: number }> {
  const key = `om:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = cacheGet(key) as { hourly: OpenMeteoHourly; fetchedAt: number } | undefined;
  if (cached?.hourly?.time?.length) return cached;
  const base = 'https://api.open-meteo.com/v1/forecast';
  const common =
    `latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    '&hourly=precipitation,precipitation_probability&past_days=2&forecast_days=7' +
    '&timezone=Asia%2FKolkata&timeformat=unixtime';
  let res = await fetch(`${base}?${common}&models=${FORECAST_MODELS.join(',')}`);
  // Only if the multi-model request itself is rejected (400) fall back to the default model.
  if (res.status === 400) res = await fetch(`${base}?${common}`);
  const body = (await res.json().catch(() => ({}))) as { hourly?: OpenMeteoHourly; reason?: string; error?: boolean };
  if (!res.ok || body.error || !body.hourly?.time) {
    throw new Error(`Open-Meteo: ${body.reason ?? `HTTP ${res.status}`}`);
  }
  const out = { hourly: body.hourly, fetchedAt: Date.now() };
  cacheSet(key, out);
  return out;
}

function nowIndexOf(times: number[]): number {
  const now = Date.now();
  let idx = 0;
  for (let i = 0; i < times.length; i++) if (times[i] <= now) idx = i;
  return idx;
}

/** Fetch best-match and worst-case (max across models) hourly series in ONE request (cached 30 min). */
export async function fetchForecastVariants(lat: number, lon: number): Promise<ForecastVariants> {
  const { hourly, fetchedAt } = await fetchHourly(lat, lon);
  const times = hourly.time.map((s) => s * 1000);
  const n = times.length;
  const precipKeys = Object.keys(hourly).filter((k) => k.startsWith('precipitation') && !k.startsWith('precipitation_probability'));
  const probKey =
    Object.keys(hourly).find((k) => k === 'precipitation_probability_best_match') ??
    Object.keys(hourly).find((k) => k.startsWith('precipitation_probability'));
  const series: Record<string, (number | null)[]> = {};
  for (const k of precipKeys) {
    const arr = hourly[k] as (number | null)[];
    if (arr.some((v) => v != null)) series[k] = arr;
  }
  const bestKey = series['precipitation_best_match'] ? 'precipitation_best_match' : series['precipitation'] ? 'precipitation' : Object.keys(series)[0];
  if (!bestKey) throw new Error('Open-Meteo: no precipitation in response');
  const best = new Array<number>(n);
  const worst = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let mx = 0;
    for (const k of Object.keys(series)) {
      const v = series[k][i];
      if (v != null && v > mx) mx = v;
    }
    worst[i] = mx;
    const b = series[bestKey][i];
    best[i] = b != null ? b : mx; // fill gaps in the default model with the envelope
  }
  const probability = probKey ? (hourly[probKey] as (number | null)[]).map((v) => v ?? 0) : undefined;
  const nowIndex = nowIndexOf(times);
  const models = Object.keys(series).map((k) => k.replace(/^precipitation_?/, '') || 'best_match');
  return {
    best: { source: 'forecast', label: 'Open-Meteo forecast (best match)', times, mm: best, probability, nowIndex },
    worst: { source: 'forecast', label: `Worst case: hourly max of ${models.length} models`, times, mm: worst, probability, nowIndex },
    models,
    fetchedAt,
  };
}

/**
 * Hourly rain for the past 2 days + next 7 days (Asia/Kolkata), from Open-Meteo (free, no key).
 * `variant: 'worst'` returns the hourly maximum across ECMWF / GFS / ICON / best_match.
 */
export async function fetchForecast(lat: number, lon: number, opts: { variant?: 'best' | 'worst' } = {}): Promise<RainSeries> {
  const v = await fetchForecastVariants(lat, lon);
  return opts.variant === 'worst' ? v.worst : v.best;
}

// ---------------------------------------------------------------- scenarios

/** ms epoch of local (IST) midnight of the given day offset from today */
function istMidnight(dayOffset = 0): number {
  const istNow = Date.now() + IST_OFFSET_MS;
  const midnightIst = Math.floor(istNow / (24 * HOUR)) * 24 * HOUR;
  return midnightIst - IST_OFFSET_MS + dayOffset * 24 * HOUR;
}

/** ms epoch for a fixed IST wall-clock date */
function istDate(y: number, m: number, d: number, hour = 0): number {
  return Date.UTC(y, m - 1, d, hour) - IST_OFFSET_MS;
}

function makeSeries(label: string, start: number, dryBefore: number, profile: number[], dryAfter: number): RainSeries {
  const mm = [...new Array(dryBefore).fill(0), ...profile, ...new Array(dryAfter).fill(0)];
  const times = mm.map((_, i) => start + i * HOUR);
  return { source: 'scenario', label, times, mm: mm.map((v) => Math.round(v * 10) / 10) };
}

export const SCENARIOS: { id: string; label: string; description: string; build(): RainSeries }[] = [
  {
    id: 'typical-evening',
    label: 'Typical monsoon evening',
    description: 'About 35 mm in 3 hours — a common heavy evening shower. Drains should cope apart from minor ponding.',
    build: () => makeSeries('Typical monsoon evening (35 mm / 3 h)', istMidnight() + 16 * HOUR, 2, [9, 17, 9], 19),
  },
  {
    id: 'rrnagar-2024-10-20',
    label: '20 Oct 2024 RR Nagar storm',
    description:
      'RR Nagar logged 177.6 mm, over 140 mm of it overnight (Weather Union). Homes in BEML Layout were flooded. ' +
      'Total is sourced; the hourly profile is a plausible reconstruction.',
    build: () =>
      makeSeries(
        '20 Oct 2024 RR Nagar storm — 177.6 mm (reconstructed hourly profile)',
        istDate(2024, 10, 20, 17),
        2,
        // 19:00-23:59 build-up (32.6 mm), then the overnight burst 00:00-06:59 (145 mm)
        [3, 6, 10, 8, 5.6, 10, 28, 38, 32, 20, 12, 5],
        24,
      ),
  },
  {
    id: 'cloudburst',
    label: 'Intense cloudburst',
    description: 'Hypothetical: about 100 mm in 4 hours, peaking at 40 mm in one hour. Well above drain design capacity.',
    build: () => makeSeries('Intense cloudburst (~100 mm / 4 h)', istMidnight() + 15 * HOUR, 2, [15, 40, 30, 15], 22),
  },
  {
    id: 'multi-day-soak',
    label: 'Multi-day soak',
    description: 'Hypothetical: three evenings in a row with about 40 mm in 3 hours each. Low spots have not drained before the next storm.',
    build: () => {
      const day = [8, 20, 12]; // 40 mm, 17:00-19:59
      const profile: number[] = [];
      for (let d = 0; d < 3; d++) profile.push(...day, ...(d < 2 ? new Array(21).fill(0) : []));
      return makeSeries('Multi-day soak (3 x 40 mm)', istMidnight() + 15 * HOUR, 2, profile, 30);
    },
  },
];

// ---------------------------------------------------------------- real storms (historical archive)

/** Show wherever archive rainfall is displayed (Open-Meteo Historical Weather API, CC BY 4.0). */
export const ARCHIVE_ATTRIBUTION = 'Past rain: Open-Meteo historical weather archive (reanalysis, CC BY 4.0)';
export const ARCHIVE_ATTRIBUTION_URL = 'https://open-meteo.com/en/docs/historical-weather-api';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
/** past rain does not change: keep it for the whole browser session */
const ARCHIVE_TTL_MS = 7 * 24 * HOUR;

/**
 * Reanalysis caveat, shown with every real storm. The archive is a gridded model re-run (ERA5 /
 * ECMWF IFS, 9-25 km cells), not a rain gauge: a convective cloudburst over a few km is smeared
 * over the cell, so totals and especially hourly peaks are usually far below the gauge figures
 * in the news reports.
 */
export const ARCHIVE_CAVEAT =
  'Hourly rain from the Open-Meteo archive at this pincode. It is a reanalysis averaged over a 9-25 km cell, ' +
  'so it usually shows much less rain, and gentler peaks, than the rain gauges in the reports.';

/** id suffix of each real storm's gauge-scaled twin: `real-2022-09-05` -> `real-2022-09-05-gauge` */
export const GAUGE_SUFFIX = '-gauge';

/** One line under every gauge-scaled storm: whose timing, whose total, and that the mix is ours. */
export const gaugeCaveat = (mm: number, gauge: string) =>
  `Hourly timing from the Open-Meteo archive at this pincode, scaled so the storm totals the ${mm} mm of the ${gauge} gauge: our adjustment, not observed hourly rain.`;

export interface HistoricalEvent {
  id: string;
  /** "Real storm: <date>" (the scaled twin adds "· scaled to <mm> mm gauge"), as listed in the scenario picker */
  label: string;
  /** first and last local (IST) day requested from the archive, YYYY-MM-DD */
  start: string;
  end: string;
  /** what was reported, with the gauge totals, then the archive caveat (or the scaling note) */
  description: string;
  /** a news report that dates the event and gives the gauge totals */
  source: string;
  /** the reported gauge total (mm), as `source` quotes it */
  gaugeMm: number;
  /** the gauge (network and place) that `source` credits with `gaugeMm` */
  gauge: string;
  /** the archive's hourly timing scaled so the event totals `gaugeMm` (our adjustment), instead of the raw archive rain */
  scaled?: boolean;
}

/**
 * A sourced flood day as two picker entries sharing one archive request: the raw archive rain,
 * and the same hours scaled to the reported gauge total (id + GAUGE_SUFFIX).
 */
function storm(id: string, when: string, start: string, end: string, reported: string, source: string, gaugeMm: number, gauge: string): HistoricalEvent[] {
  const base = { start, end, source, gaugeMm, gauge };
  return [
    { ...base, id, label: `Real storm: ${when}`, description: `${reported} (${source}) ${ARCHIVE_CAVEAT}` },
    {
      ...base,
      id: id + GAUGE_SUFFIX,
      label: `Real storm: ${when} · scaled to ${gaugeMm} mm gauge`,
      description: `${reported} (${source}) ${gaugeCaveat(gaugeMm, gauge)}`,
      scaled: true,
    },
  ];
}

/**
 * Known Bengaluru flood days. Each date range, place and gauge total is in the linked report's text
 * (checked 2026-10-18). The 2022-05 total is a lower bound: the report says "over 114 mm".
 */
export const HISTORICAL_EVENTS: HistoricalEvent[] = [
  ...storm(
    'real-2024-10-20',
    '20-22 Oct 2024',
    '2024-10-20',
    '2024-10-22',
    "KSNDMC's Yelahanka gauge measured 190 mm (GKVK 186.4 mm) as rain pounded the city from the early hours of 22 Oct. Boats evacuated close to 1,000 residents of Kendriya Vihar in Yelahanka, over 100 lakes overflowed and over 4,000 houses were hit.",
    'https://www.deccanherald.com/india/karnataka/bengaluru/intense-rainfall-cripples-bengaluru-hundreds-evacuated-3244157',
    190,
    'KSNDMC Yelahanka',
  ),
  ...storm(
    'real-2022-09-05',
    '4-6 Sep 2022',
    '2022-09-04',
    '2022-09-06',
    'IMD measured 131 mm in the city overnight into 5 Sep, and most of Mahadevapura had 110-140 mm in 24 hours. Traffic stalled on flooded stretches of the ORR at Bellandur, Sarjapur Road and Yemalur Main Road, and about 30 apartment complexes were still under water that morning.',
    'https://www.thenewsminute.com/article/bengaluru-flooded-after-rains-traffic-advisory-issued-people-asked-stay-home-167536',
    131,
    'IMD Bengaluru city',
  ),
  ...storm(
    'real-2022-05-17',
    '17-18 May 2022',
    '2022-05-17',
    '2022-05-18',
    "IMD measured over 114 mm in under 12 hours on 17 May; KSNDMC's Horamavu gauge had 155 mm. Two labourers died at a flooded pipeline work site, and houses flooded in RR Nagar, Koramangala, Hoskerehalli, Horamavu and HBR Layout.",
    'https://scroll.in/latest/1024189/two-labourers-die-in-bengaluru-after-heavy-rains-cause-flooding',
    114,
    'IMD Bengaluru',
  ),
  ...storm(
    'real-2017-08-15',
    '14-16 Aug 2017',
    '2017-08-14',
    '2017-08-16',
    "IMD's HAL airport observatory measured 144 mm on the night of 14-15 Aug, and KSNDMC 184 mm at Bilekahalli. Water entered homes in Koramangala, Wilson Garden, Bilekahalli, Indiranagar and other areas.",
    'https://www.thenewsminute.com/karnataka/rains-lash-bengaluru-leave-several-areas-city-waterlogged-66805',
    144,
    'IMD HAL airport',
  ),
];

/** Dry hours kept ahead of the first wet hour, and appended after the last one (the recession). */
export const HISTORICAL_PAD = { before: 3, after: 24 };
/** an hour with less than this is treated as dry when trimming */
const WET_MM = 0.1;

export interface ArchiveHourly {
  /** unix seconds (timeformat=unixtime) */
  time: number[];
  precipitation: (number | null)[];
}

/**
 * Scale hourly rain so it adds up to `totalMm` (pure). Every hour gets the same factor and is kept
 * to 0.1 mm; the leftover tenths go to the hours with the largest remainders (earlier hour first on
 * a tie), so the rounded series sums to `totalMm` exactly. Dry hours stay dry; so does a dry series.
 */
export function scaleToTotal(mm: number[], totalMm: number): number[] {
  const sum = mm.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  if (!(sum > 0)) return mm.map(() => 0);
  const target = Math.max(0, totalMm);
  const exact = mm.map((v) => (v > 0 ? (v * target * 10) / sum : 0)); // tenths of a mm
  const out = exact.map((v) => Math.floor(v + 1e-9));
  let left = Math.round(target * 10) - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((_, i) => i)
    .filter((i) => exact[i] > 0)
    .sort((a, b) => exact[b] - out[b] - (exact[a] - out[a]) || a - b);
  for (let j = 0; left > 0 && j < order.length; j++, left--) out[order[j]]++;
  return out.map((t) => t / 10);
}

/**
 * Archive hourly rain -> RainSeries (pure, no network). Trims to the wet window (first to last hour
 * with >= 0.1 mm), keeps `pad.before` dry hours ahead of it (prepending zero hours when the archive
 * starts wet) and appends `pad.after` dry hours. Missing hours count as dry. An all-dry archive
 * gives the whole requested range, dry. A `scaled` event multiplies every hour by
 * gaugeMm / (archive total over that wet window), so the series totals the reported gauge reading.
 */
export function buildHistoricalSeries(ev: HistoricalEvent, hourly: ArchiveHourly, pad = HISTORICAL_PAD): RainSeries {
  const n = hourly.time?.length ?? 0;
  if (!n || hourly.precipitation?.length !== n) throw new Error('Open-Meteo archive: no hourly precipitation');
  const raw = hourly.precipitation.map((v) => (v != null && Number.isFinite(v) && v > 0 ? v : 0));
  let first = raw.findIndex((v) => v >= WET_MM);
  let last = n - 1;
  while (last >= 0 && raw[last] < WET_MM) last--;
  if (first < 0) [first, last] = [0, n - 1];
  const s0 = Math.max(0, first - pad.before);
  const extra = pad.before - (first - s0);
  const mm = [...new Array(extra).fill(0), ...raw.slice(s0, last + 1), ...new Array(pad.after).fill(0)].map((v) => Math.round(v * 10) / 10);
  const t0 = hourly.time[s0] * 1000 - extra * HOUR;
  const times = mm.map((_, i) => t0 + i * HOUR);
  const total = mm.reduce((a, b) => a + b, 0);
  if (!ev.scaled) return { source: 'scenario', label: `${ev.label}: ${total.toFixed(0)} mm (Open-Meteo archive)`, times, mm };
  const how = total > 0 ? `archive ${total.toFixed(1)} mm x ${(ev.gaugeMm / total).toFixed(2)}` : 'the archive is dry here, nothing to scale';
  return { source: 'scenario', label: `${ev.label} (${how})`, times, mm: scaleToTotal(mm, ev.gaugeMm) };
}

/** Archive request for one event at one point (hourly precipitation, IST days, unix seconds). */
export function archiveUrl(lat: number, lon: number, ev: HistoricalEvent): string {
  return (
    `${ARCHIVE_URL}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&start_date=${ev.start}&end_date=${ev.end}&hourly=precipitation&timezone=Asia%2FKolkata&timeformat=unixtime`
  );
}

/** archive blocks fetched in this page (or Node run): a storm's raw and scaled entries share one request */
const archiveMem = new Map<string, ArchiveHourly>();

/**
 * Real hourly rain for a past storm at [lat, lon] from Open-Meteo's free, keyless historical
 * archive, trimmed and padded (and, for a scaled entry, scaled) by buildHistoricalSeries.
 * Cached in memory and in sessionStorage (when available), keyed by the request, not the entry.
 */
export async function fetchHistoricalEvent(lat: number, lon: number, ev: HistoricalEvent): Promise<RainSeries> {
  const key = `oma:${ev.start}:${ev.end}:${lat.toFixed(3)},${lon.toFixed(3)}`;
  let hourly = archiveMem.get(key) ?? (cacheGet(key, ARCHIVE_TTL_MS) as ArchiveHourly | undefined);
  if (!hourly?.time?.length) {
    const res = await fetch(archiveUrl(lat, lon, ev));
    const body = (await res.json().catch(() => ({}))) as { hourly?: ArchiveHourly; reason?: string; error?: boolean };
    if (!res.ok || body.error || !body.hourly?.time) throw new Error(`Open-Meteo archive: ${body.reason ?? `HTTP ${res.status}`}`);
    hourly = body.hourly;
    cacheSet(key, hourly);
  }
  archiveMem.set(key, hourly);
  return buildHistoricalSeries(ev, hourly);
}
