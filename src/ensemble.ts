// Prediction range across weather models (pure: no DOM, no worker). src/ensembleRun.ts runs the
// flood model on each model's rain and fills a MemberResult per model; this file folds those into
// the min–max ranges, the "worst model" line and the timeline band that the UI shows.
import type { Severity } from './types.ts';

/** What the flood prediction on one weather model's rain comes to. */
export interface MemberResult {
  /** Open-Meteo model id, e.g. 'gfs_seamless' */
  model: string;
  /** display name, e.g. 'NOAA GFS' */
  name: string;
  /** rain in the outlook window (the next 48 h), mm */
  rainMm: number;
  /** flooded area (m², water deeper than 0.1 m) in every hour of the series */
  area: number[];
  /** hour with the largest flooded area in the outlook window */
  peakHour: number;
  /** at peakHour: flooded area, km² */
  floodedKm2: number;
  /** at peakHour: road shut to two-wheelers (> 15 cm) and to cars (> 30 cm), km */
  twoWheelerKm: number;
  carKm: number;
  /** at peakHour: buildings with water above plinth height */
  buildingsWet: number;
  /** at peakHour; 'none' while the peak stays under the dry threshold */
  severity: Severity;
}

export interface Range {
  min: number;
  max: number;
}

export interface EnsembleSummary {
  /** number of weather models */
  n: number;
  /** every model's outlook is 'none': show nothing extra */
  dry: boolean;
  floodedKm2: Range;
  twoWheelerKm: Range;
  carKm: Range;
  buildingsWet: Range;
  /** the model with the worst outcome (severity, then flooded area), only when it is worse than the baseline */
  worse: { model: string; name: string; severity: Severity } | null;
  /** lowest and highest flooded area across the models in every hour (m²): the timeline band */
  band: { lo: number[]; hi: number[] };
  members: MemberResult[];
}

export const SEV_RANK: Record<Severity, number> = { none: 0, low: 1, moderate: 2, high: 3, severe: 4 };

/** Hour with the largest value in [from, from + hours) (the first such hour); `from` when all are equal. */
export function outlookPeak(area: number[], from: number, hours: number): number {
  const a = Math.max(0, Math.min(from, area.length - 1));
  const b = Math.min(area.length, a + hours);
  let peak = a;
  for (let h = a; h < b; h++) if ((area[h] ?? 0) > (area[peak] ?? 0)) peak = h;
  return peak;
}

function range(xs: number[]): Range {
  return { min: Math.min(...xs), max: Math.max(...xs) };
}

/**
 * Fold the per-model results into ranges. `baseline` is the severity of the prediction on screen
 * (the best estimate); `worse` names a model only when its outcome is more severe than that.
 * Fewer than two models give no range (null).
 */
export function aggregateEnsemble(members: MemberResult[], baseline: Severity): EnsembleSummary | null {
  if (members.length < 2) return null;
  const n = members.length;
  const hours = Math.max(...members.map((m) => m.area.length));
  const lo = new Array<number>(hours);
  const hi = new Array<number>(hours);
  for (let h = 0; h < hours; h++) {
    let mn = Infinity;
    let mx = 0;
    for (const m of members) {
      const v = m.area[h] ?? 0;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    lo[h] = mn;
    hi[h] = mx;
  }
  let worst = members[0];
  for (const m of members) {
    const d = SEV_RANK[m.severity] - SEV_RANK[worst.severity];
    if (d > 0 || (d === 0 && m.floodedKm2 > worst.floodedKm2)) worst = m;
  }
  return {
    n,
    dry: members.every((m) => m.severity === 'none'),
    floodedKm2: range(members.map((m) => m.floodedKm2)),
    twoWheelerKm: range(members.map((m) => m.twoWheelerKm)),
    carKm: range(members.map((m) => m.carKm)),
    buildingsWet: range(members.map((m) => m.buildingsWet)),
    worse: SEV_RANK[worst.severity] > SEV_RANK[baseline] ? { model: worst.model, name: worst.name, severity: worst.severity } : null,
    band: { lo, hi },
    members,
  };
}

/** "a–b", or one value when both ends read the same. An end that rounds to zero reads "0". */
export function rangeText(r: Range, fmt: (v: number) => string): string {
  const f = (v: number) => {
    const s = fmt(v);
    return Number(s.replace(/,/g, '')) === 0 ? '0' : s;
  };
  const a = f(r.min);
  const b = f(r.max);
  return a === b ? a : `${a}–${b}`;
}

/** The unit flooded areas up to `top` km² read in: km² (>= 0.01 km²), ha (>= 0.1 ha), else m². */
function areaUnit(top: number): [(km2: number) => string, string] {
  if (top >= 0.01) return [(v) => v.toFixed(2), 'km²'];
  if (top >= 0.001) return [(v) => (v * 100).toFixed(1), 'ha'];
  return [(v) => Math.round(v * 1e6).toLocaleString('en-IN'), 'm²'];
}

/** A flooded-area range in one unit picked from its upper end. */
export function areaRangeText(km2: Range): string {
  const [f, unit] = areaUnit(km2.max);
  return `${rangeText(km2, f)} ${unit}`;
}

/** One flooded area in the unit of a range that tops out at `top` km², so a list of models reads in one unit. */
export function areaText(km2: number, top: number): string {
  const [f, unit] = areaUnit(top);
  return `${rangeText({ min: km2, max: km2 }, f)} ${unit}`;
}

/** The status line under the header's answer; empty when every model stays dry. */
export function ensembleStatusText(s: EnsembleSummary | null): string {
  if (!s || s.dry) return '';
  return `Flooded area ${areaRangeText(s.floodedKm2)} across ${s.n} weather models`;
}
