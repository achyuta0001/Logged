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

function cacheGet(key: string): unknown {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as { t: number; data: unknown };
    if (Date.now() - v.t > CACHE_TTL_MS) return undefined;
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
