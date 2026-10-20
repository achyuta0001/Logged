// Commute risk engine: rain at a hotspot -> a level per 30-minute bucket, with every input and term
// kept so the UI can show why. Pure functions, no DOM, no network; the numbers are in config.ts.
//
// Rain comes in as a RainTrack: regular buckets of mean intensity (mm/h). trackFromSums builds one
// from Open-Meteo's hourly or 15-minute values, which are sums over the period that ENDS at their
// timestamp ("preceding hour"), so a value stamped 15:00 is the rain of 14:00-15:00.
import type { CommuteHotspot, HotspotOutlook, HotspotRisk, RiskExplain, RiskLevel } from './types.ts';
import { BUCKET_MS, DEPTH_FLOOR_M, HORIZON_H, LEVEL_FROM, SCORE, THRESHOLD_SCALE, TYPE_THRESHOLD_MMHR } from './config.ts';

const H = 3600e3;

export const LEVELS: readonly RiskLevel[] = ['clear', 'watch', 'likely', 'severe'];
export const LEVEL_RANK: Record<RiskLevel, number> = { clear: 0, watch: 1, likely: 2, severe: 3 };
export const worstLevel = (a: RiskLevel, b: RiskLevel): RiskLevel => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a);
export const atLeast = (l: RiskLevel, min: RiskLevel) => LEVEL_RANK[l] >= LEVEL_RANK[min];

/** Short labels. "Clear" is the lowest level, not a promise: never show it as "safe". */
export const LEVEL_TEXT: Record<RiskLevel, string> = {
  clear: 'Clear',
  watch: 'Watch',
  likely: 'Likely waterlogged',
  severe: 'Severe waterlogging likely',
};
export const LEVEL_HINT: Record<RiskLevel, string> = {
  clear: 'Lowest level: little rain expected here. Not a guarantee the road is dry.',
  watch: 'Rain near the level that has waterlogged this spot before.',
  likely: 'Rain at or above the level that has waterlogged this spot before.',
  severe: 'Rain well above that level, or the flood model has deep water here.',
};

// ------------------------------------------------------------------ rain tracks

/** Rain at one place: bucket i covers [t0 + i*stepMs, t0 + (i+1)*stepMs), mean intensity mmHr[i] (mm/h). */
export interface RainTrack {
  t0: number;
  stepMs: number;
  mmHr: number[];
}

/**
 * Period sums (mm) stamped at the END of each period (Open-Meteo hourly / minutely_15) -> a track of
 * `stepMs` buckets aligned to multiples of stepMs. Each period's rain is spread evenly over it.
 * Missing values (null) count as dry. Times are ms epoch.
 */
export function trackFromSums(times: number[], mm: (number | null | undefined)[], periodMs: number, stepMs = BUCKET_MS): RainTrack {
  if (!times.length) return { t0: 0, stepMs, mmHr: [] };
  const start = Math.floor((times[0] - periodMs) / stepMs) * stepMs;
  const end = Math.ceil(times[times.length - 1] / stepMs) * stepMs;
  const n = Math.max(0, Math.round((end - start) / stepMs));
  const acc = new Array<number>(n).fill(0);
  for (let k = 0; k < times.length; k++) {
    const v = mm[k];
    if (v == null || !Number.isFinite(v) || v <= 0) continue;
    const a = times[k] - periodMs, b = times[k];
    for (let i = Math.max(0, Math.floor((a - start) / stepMs)); i < n; i++) {
      const s = start + i * stepMs, e = s + stepMs;
      if (s >= b) break;
      const ov = Math.min(b, e) - Math.max(a, s);
      if (ov > 0) acc[i] += (v * ov) / periodMs;
    }
  }
  return { t0: start, stepMs, mmHr: acc.map((x) => Math.round((x * H * 1000) / stepMs) / 1000) };
}

/** first ms after the last bucket */
export const trackEnd = (tr: RainTrack) => tr.t0 + tr.mmHr.length * tr.stepMs;

/** Mean intensity (mm/h) in the bucket containing t, or NaN outside the track. */
export function rainAt(tr: RainTrack, t: number): number {
  const i = Math.floor((t - tr.t0) / tr.stepMs);
  return i >= 0 && i < tr.mmHr.length ? tr.mmHr[i] : NaN;
}

/** Rain (mm) that falls in [a, b); the part outside the track counts as dry. */
export function rainBetween(tr: RainTrack, a: number, b: number): number {
  let s = 0;
  const i0 = Math.max(0, Math.floor((a - tr.t0) / tr.stepMs));
  const i1 = Math.min(tr.mmHr.length - 1, Math.floor((b - tr.t0 - 1) / tr.stepMs));
  for (let i = i0; i <= i1; i++) {
    const s0 = tr.t0 + i * tr.stepMs, e0 = s0 + tr.stepMs;
    const ov = Math.min(b, e0) - Math.max(a, s0);
    if (ov > 0) s += (tr.mmHr[i] * ov) / H;
  }
  return Math.round(s * 100) / 100;
}

// ------------------------------------------------------------------ scoring

export interface RiskInputs {
  rainNextMmHr: number;
  rainLast1hMm: number;
  rainLast24hMm: number;
  thresholdMmHr: number;
  lowness: number;
  reportDays: number;
  modelDepthM?: number;
}

const clamp01 = (x: number) => (x > 1 ? 1 : x > 0 ? x : 0);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Threshold (mm/h) for a hotspot: its own, else its type's, times the global scale. */
export function thresholdOf(h: Pick<CommuteHotspot, 'type' | 'thresholdMmHr'>, scale = THRESHOLD_SCALE): number {
  const base = h.thresholdMmHr && h.thresholdMmHr > 0 ? h.thresholdMmHr : TYPE_THRESHOLD_MMHR[h.type] ?? TYPE_THRESHOLD_MMHR.road;
  return base * scale;
}

/**
 * The score and its terms. They add up to the score:
 *   rain        rain in the bucket / threshold
 *   recentRain  persist x last hour's rain / threshold (water still standing)
 *   antecedent  (rain + recentRain) x antecedentW x min(1, last 24 h / antecedentSatMm)
 *   lowness     (rain + recentRain) x lownessW x lowness
 *   history     (rain + recentRain) x historyW x min(1, ln(1 + reportDays) / ln(1 + historySatDays))
 *   modelDepth  depthW x min(1, depth / depthSatM), only when a flood model covers the spot
 * With no rain the first five are all zero: ground and history alone never raise a level.
 */
export function scoreRisk(x: RiskInputs): RiskExplain {
  const thr = x.thresholdMmHr > 0 ? x.thresholdMmHr : TYPE_THRESHOLD_MMHR.road;
  const rain = Math.max(0, x.rainNextMmHr) / thr;
  const recentRain = (SCORE.persist * Math.max(0, x.rainLast1hMm)) / thr;
  const base = rain + recentRain;
  const terms: Record<string, number> = {
    rain: r3(rain),
    recentRain: r3(recentRain),
    antecedent: r3(base * SCORE.antecedentW * clamp01(x.rainLast24hMm / SCORE.antecedentSatMm)),
    lowness: r3(base * SCORE.lownessW * clamp01(x.lowness)),
    history: r3(base * SCORE.historyW * clamp01(Math.log1p(Math.max(0, x.reportDays)) / Math.log1p(SCORE.historySatDays))),
  };
  if (x.modelDepthM != null && Number.isFinite(x.modelDepthM)) terms.modelDepth = r3(SCORE.depthW * clamp01(x.modelDepthM / SCORE.depthSatM));
  const score = r3(Object.values(terms).reduce((a, b) => a + b, 0));
  const out: RiskExplain = {
    rainNextMmHr: r3(x.rainNextMmHr),
    rainLast1hMm: r3(x.rainLast1hMm),
    rainLast24hMm: r3(x.rainLast24hMm),
    thresholdMmHr: r3(thr),
    lowness: x.lowness,
    reportDays: x.reportDays,
    terms,
    score,
  };
  if (x.modelDepthM != null && Number.isFinite(x.modelDepthM)) out.modelDepthM = x.modelDepthM;
  return out;
}

/** Level from a score: the LEVEL_FROM bands, clear under minRainMmHr, and the flood-model depth floor. */
export function levelOf(x: RiskExplain): RiskLevel {
  const s = x.score;
  let lv: RiskLevel = s >= LEVEL_FROM.severe ? 'severe' : s >= LEVEL_FROM.likely ? 'likely' : s >= LEVEL_FROM.watch ? 'watch' : 'clear';
  if (x.rainNextMmHr + SCORE.persist * x.rainLast1hMm < SCORE.minRainMmHr) lv = 'clear';
  const d = x.modelDepthM;
  if (d != null && Number.isFinite(d)) {
    const floor: RiskLevel = d >= DEPTH_FLOOR_M.severe ? 'severe' : d >= DEPTH_FLOOR_M.likely ? 'likely' : d >= DEPTH_FLOOR_M.watch ? 'watch' : 'clear';
    lv = worstLevel(lv, floor);
  }
  return lv;
}

/** The rain inputs for the bucket starting at t: intensity in it, the hour and the 24 h before it. */
export function rainInputs(tr: RainTrack, t: number) {
  return { rainNextMmHr: rainAt(tr, t), rainLast1hMm: rainBetween(tr, t - H, t), rainLast24hMm: rainBetween(tr, t - 24 * H, t) };
}

export type HotspotLike = Pick<CommuteHotspot, 'id' | 'type' | 'thresholdMmHr' | 'lowness' | 'reportDays'>;

export interface OutlookOptions {
  /** first bucket: the one containing `from` (default now) */
  from?: number;
  /** end (exclusive, ms); default from + HORIZON_H hours; clipped to the end of the rain track */
  to?: number;
  /** flood-model depth (m) at the hotspot at time t, when a pincode model covers it */
  depthAt?: (id: string, t: number) => number | undefined;
  /** threshold scale (default THRESHOLD_SCALE): the backtest varies it */
  scale?: number;
}

/** Risk for one hotspot in the bucket starting at t (t is floored to the bucket grid). */
export function hotspotRisk(h: HotspotLike, tr: RainTrack, t: number, opts: Pick<OutlookOptions, 'depthAt' | 'scale'> = {}): HotspotRisk {
  const b = Math.floor(t / BUCKET_MS) * BUCKET_MS;
  const rain = rainInputs(tr, b);
  const depth = opts.depthAt?.(h.id, b);
  const explain = scoreRisk({
    ...rain,
    rainNextMmHr: Number.isFinite(rain.rainNextMmHr) ? rain.rainNextMmHr : 0,
    thresholdMmHr: thresholdOf(h, opts.scale),
    lowness: h.lowness,
    reportDays: h.reportDays,
    modelDepthM: depth,
  });
  return { id: h.id, t: b, level: levelOf(explain), explain };
}

/** Buckets from `from` to `to` (only those the rain track covers), and the likely-or-worse window. */
export function hotspotOutlook(h: HotspotLike, tr: RainTrack, opts: OutlookOptions = {}): HotspotOutlook {
  const from = Math.floor((opts.from ?? Date.now()) / BUCKET_MS) * BUCKET_MS;
  const to = Math.min(opts.to ?? from + HORIZON_H * H, trackEnd(tr));
  const buckets: HotspotRisk[] = [];
  for (let t = Math.max(from, tr.t0); t < to; t += BUCKET_MS) buckets.push(hotspotRisk(h, tr, t, opts));
  return { id: h.id, buckets, window: riskWindow(buckets) };
}

/** First and last bucket start at likely or worse, else null. */
export function riskWindow(buckets: HotspotRisk[]): [number, number] | null {
  let a = -1, b = -1;
  for (let i = 0; i < buckets.length; i++)
    if (atLeast(buckets[i].level, 'likely')) {
      if (a < 0) a = i;
      b = i;
    }
  return a < 0 ? null : [buckets[a].t, buckets[b].t];
}

/** Outlooks for many hotspots; a hotspot without a rain track is left out. */
export function outlooks(hotspots: HotspotLike[], trackOf: (id: string) => RainTrack | undefined, opts: OutlookOptions = {}): Map<string, HotspotOutlook> {
  const out = new Map<string, HotspotOutlook>();
  const from = opts.from ?? Date.now();
  for (const h of hotspots) {
    const tr = trackOf(h.id);
    if (tr) out.set(h.id, hotspotOutlook(h, tr, { ...opts, from }));
  }
  return out;
}

/** The level an outlook gives at time t (the bucket containing t), or null when t is outside it. */
export function levelAt(o: HotspotOutlook | undefined, t: number): RiskLevel | null {
  if (!o || !o.buckets.length) return null;
  const i = Math.floor((t - o.buckets[0].t) / BUCKET_MS);
  return i >= 0 && i < o.buckets.length && o.buckets[i].t <= t ? o.buckets[i].level : null;
}
