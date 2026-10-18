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

export interface HistoricalEvent {
  id: string;
  /** "Real storm: <date>", as listed in the scenario picker */
  label: string;
  /** first and last local (IST) day requested from the archive, YYYY-MM-DD */
  start: string;
  end: string;
  /** what was reported, with the gauge totals, then the archive caveat */
  description: string;
  /** a news report that dates the event and gives the gauge totals */
  source: string;
}

const event = (id: string, label: string, start: string, end: string, reported: string, source: string): HistoricalEvent => ({
  id,
  label,
  start,
  end,
  description: `${reported} (${source}) ${ARCHIVE_CAVEAT}`,
  source,
});

/** Known Bengaluru flood days. Each date range is checked against the linked report. */
export const HISTORICAL_EVENTS: HistoricalEvent[] = [
  event(
    'real-2024-10-20',
    'Real storm: 20-22 Oct 2024',
    '2024-10-20',
    '2024-10-22',
    'RR Nagar logged 177.6 mm overnight on 20-21 Oct; on 21-22 Oct Yelahanka had 157 mm in six hours, Kogilu lake breached and Kendriya Vihar was evacuated by boat.',
    'https://www.etvbharat.com/en/!state/heavy-rains-flood-bengaluru-enn24102202323',
  ),
  event(
    'real-2022-09-05',
    'Real storm: 4-6 Sep 2022',
    '2022-09-04',
    '2022-09-06',
    'IMD measured 131 mm overnight into 5 Sep. Bellandur lake overflowed onto the ORR; Yemalur, Sarjapur Road and Mahadevapura layouts were reached by boat and tractor.',
    'https://www.thenewsminute.com/article/bengaluru-flooded-after-rains-traffic-advisory-issued-people-asked-stay-home-167536',
  ),
  event(
    'real-2022-05-17',
    'Real storm: 17-18 May 2022',
    '2022-05-17',
    '2022-05-18',
    'IMD measured 114.6 mm on 17 May, Horamavu 155 mm. Two workers died at a flooded pipeline site in Ullal Upanagar; basements flooded in HSR Layout and Rajajinagar.',
    'https://scroll.in/latest/1024189/two-labourers-die-in-bengaluru-after-heavy-rains-cause-flooding',
  ),
  event(
    'real-2017-08-15',
    'Real storm: 14-16 Aug 2017',
    '2017-08-14',
    '2017-08-16',
    'HAL airport measured 144 mm on the night of 14-15 Aug, Bilekahalli 184 mm. Over 300 homes in Koramangala flooded, as did HSR Layout and Wilson Garden.',
    'https://www.thenewsminute.com/karnataka/rains-lash-bengaluru-leave-several-areas-city-waterlogged-66805',
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
 * Archive hourly rain -> RainSeries (pure, no network). Trims to the wet window (first to last hour
 * with >= 0.1 mm), keeps `pad.before` dry hours ahead of it (prepending zero hours when the archive
 * starts wet) and appends `pad.after` dry hours. Missing hours count as dry. An all-dry archive
 * gives the whole requested range, dry.
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
  return { source: 'scenario', label: `${ev.label}: ${total.toFixed(0)} mm (Open-Meteo archive)`, times, mm };
}

/** Archive request for one event at one point (hourly precipitation, IST days, unix seconds). */
export function archiveUrl(lat: number, lon: number, ev: HistoricalEvent): string {
  return (
    `${ARCHIVE_URL}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&start_date=${ev.start}&end_date=${ev.end}&hourly=precipitation&timezone=Asia%2FKolkata&timeformat=unixtime`
  );
}

/**
 * Real hourly rain for a past storm at [lat, lon] from Open-Meteo's free, keyless historical
 * archive, trimmed and padded by buildHistoricalSeries. Cached in sessionStorage (when available).
 */
export async function fetchHistoricalEvent(lat: number, lon: number, ev: HistoricalEvent): Promise<RainSeries> {
  const key = `oma:${ev.id}:${lat.toFixed(3)},${lon.toFixed(3)}`;
  let hourly = cacheGet(key, ARCHIVE_TTL_MS) as ArchiveHourly | undefined;
  if (!hourly?.time?.length) {
    const res = await fetch(archiveUrl(lat, lon, ev));
    const body = (await res.json().catch(() => ({}))) as { hourly?: ArchiveHourly; reason?: string; error?: boolean };
    if (!res.ok || body.error || !body.hourly?.time) throw new Error(`Open-Meteo archive: ${body.reason ?? `HTTP ${res.status}`}`);
    hourly = body.hourly;
    cacheSet(key, hourly);
  }
  return buildHistoricalSeries(ev, hourly);
}
