// Commute check: rain around a departure time, plus the model's water at the reported flood spots
// on the route, gives a plain verdict per spot and for the trip. Pure logic, no DOM; times are
// ms epoch, clocks are IST (Asia/Kolkata, UTC+5:30, no daylight saving).
//
// The rules, kept simple on purpose:
//  - Rain window: the forecast hours from 2 h before to 2 h after leaving (hourly totals).
//  - Rain classes per hour (WMO/AMS hourly intensity): light < 2.5 mm, moderate 2.5-7.6, heavy > 7.6.
//  - A spot is "Likely flooded" when the model has >= 15 cm of water within 30 m of it at the
//    departure hour (two-wheelers stall), or heavy rain falls in the window at a spot reported
//    flooded on 3 or more days. "Watch" when the model has >= 5 cm there, or the window has
//    moderate rain. Otherwise "Likely clear".
//  - The trip takes its worst spot, and is "Likely flooded" when the route itself is cut at that hour.
//  - Suggestion: the run of moderate-or-heavier hours that overlaps the window; leave before it
//    starts, or after the water on the route has gone (first later hour the model has every spot
//    below 15 cm and the route open), else one hour after the rain stops.
import type { LngLat } from './spots.ts';

export const MODERATE_MM = 2.5;
export const HEAVY_MM = 7.6;
export const WET_M = 0.05;
export const STALL_M = 0.15;
export const OFTEN = 3;
const H = 3600e3;
const IST = 5.5 * H;

export type Verdict = 'clear' | 'watch' | 'flooded';
export const VERDICT_TEXT: Record<Verdict, string> = { clear: 'Likely clear', watch: 'Watch', flooded: 'Likely flooded' };
const RANK: Record<Verdict, number> = { clear: 0, watch: 1, flooded: 2 };
export const worst = (a: Verdict, b: Verdict): Verdict => (RANK[b] > RANK[a] ? b : a);

// ------------------------------------------------------------------ clock (IST)

/** IST wall clock of a time: [weekday 0=Sun, hours, minutes] */
export function istParts(t: number): { day: number; h: number; m: number } {
  const d = new Date(t + IST);
  return { day: d.getUTCDay(), h: d.getUTCHours(), m: d.getUTCMinutes() };
}

/** "HH:MM" -> [h, m], or null */
export function parseHHMM(s: string | null | undefined): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? [h, mi] : null;
}

export const fmtHHMM = (t: number) => {
  const p = istParts(t);
  return `${String(p.h).padStart(2, '0')}:${String(p.m).padStart(2, '0')}`;
};

/** The next Monday-Friday at hh:mm IST at or after `now`. */
export function nextWeekdayAt(now: number, h: number, m = 0): number {
  const day0 = Math.floor((now + IST) / (24 * H)) * 24 * H - IST; // IST midnight today
  for (let k = 0; k < 8; k++) {
    const t = day0 + k * 24 * H + h * H + m * 60e3;
    const wd = istParts(t).day;
    if (t >= now && wd >= 1 && wd <= 5) return t;
  }
  return day0 + h * H;
}

/** The next weekday commute: 09:00, or 18:00 once the morning one has passed. */
export function nextCommute(now: number): { t: number; slot: 'am' | 'pm' } {
  const am = nextWeekdayAt(now, 9), pm = nextWeekdayAt(now, 18);
  return pm < am ? { t: pm, slot: 'pm' } : { t: am, slot: 'am' };
}

// ------------------------------------------------------------------ rain

export interface RainWindow {
  /** the departure falls inside the series */
  inRange: boolean;
  totalMm: number;
  peakMm: number;
  /** time of the wettest hour */
  peakAt: number;
  /** hour index of the departure in the series (-1 outside) */
  depIndex: number;
}

/** Index of the hour containing t (times are hourly starts), or -1 outside the series. */
export function hourIndex(times: number[], t: number): number {
  if (!times.length || t < times[0] || t >= times[times.length - 1] + H) return -1;
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Rain in the hours from `hours` before to `hours` after the departure. */
export function rainAround(times: number[], mm: number[], dep: number, hours = 2): RainWindow {
  const depIndex = hourIndex(times, dep);
  let total = 0, peak = 0, peakAt = dep;
  for (let i = 0; i < times.length; i++) {
    if (times[i] < dep - hours * H - H / 2 || times[i] > dep + hours * H) continue;
    total += mm[i] ?? 0;
    if ((mm[i] ?? 0) > peak) {
      peak = mm[i];
      peakAt = times[i];
    }
  }
  return { inRange: depIndex >= 0, totalMm: Math.round(total * 10) / 10, peakMm: peak, peakAt, depIndex };
}

export const rainClass = (mmH: number) => (mmH > HEAVY_MM ? 'heavy' : mmH >= MODERATE_MM ? 'moderate' : mmH > 0.2 ? 'light' : 'none');

export interface Spell {
  /** first wet hour (start time) and the end of the last one */
  from: number;
  to: number;
  peakMm: number;
  heavy: boolean;
  /** index range in the series */
  i0: number;
  i1: number;
}

/** The run of hours with >= `thr` mm that overlaps the departure window (the wettest if several). */
export function rainSpell(times: number[], mm: number[], dep: number, hours = 2, thr = MODERATE_MM): Spell | null {
  let best: Spell | null = null;
  for (let i = 0; i < times.length; i++) {
    if (!((mm[i] ?? 0) >= thr)) continue;
    let j = i;
    while (j + 1 < times.length && (mm[j + 1] ?? 0) >= thr) j++;
    const from = times[i], to = times[j] + H;
    let peak = 0;
    for (let k = i; k <= j; k++) peak = Math.max(peak, mm[k]);
    if (to > dep - hours * H && from <= dep + hours * H && (!best || peak > best.peakMm)) best = { from, to, peakMm: peak, heavy: peak > HEAVY_MM, i0: i, i1: j };
    i = j;
  }
  return best;
}

// ------------------------------------------------------------------ verdicts

/** One reported spot at the departure hour: modelled water (null = outside the model) and rain. */
export function spotVerdict(depthM: number | null, rain: Pick<RainWindow, 'peakMm'>, reportedDays: number): Verdict {
  if (depthM !== null && depthM >= STALL_M) return 'flooded';
  if (rain.peakMm > HEAVY_MM && reportedDays >= OFTEN) return 'flooded';
  if ((depthM !== null && depthM >= WET_M) || rain.peakMm >= MODERATE_MM) return 'watch';
  return 'clear';
}

/** The trip: its worst spot, or flooded when the route is cut at that hour. */
export function tripVerdict(spots: Verdict[], route: { blocked: boolean; maxDepthM: number }): Verdict {
  let v: Verdict = 'clear';
  for (const s of spots) v = worst(v, s);
  if (route.blocked || route.maxDepthM >= STALL_M) v = worst(v, 'flooded');
  else if (route.maxDepthM >= WET_M) v = worst(v, 'watch');
  return v;
}

const hh = (t: number) => String(istParts(t).h).padStart(2, '0');

/**
 * "Heavy rain 17–19 h: leave before 17:00 or after 20:00." `clearAt` is when the route is clear
 * again (from the model); without it, one hour after the rain stops.
 */
export function suggestion(spell: Spell | null, clearAt?: number | null): string {
  if (!spell) return '';
  const after = clearAt && clearAt >= spell.to ? clearAt : spell.to + H;
  const what = spell.heavy ? 'Heavy rain' : 'Moderate rain';
  return `${what} ${hh(spell.from)}–${hh(spell.to)} h: leave before ${fmtHHMM(spell.from)} or after ${fmtHHMM(after)}.`;
}

// ------------------------------------------------------------------ shareable link

export interface CommuteLink {
  from: LngLat;
  to: LngLat;
  /** "HH:MM" */
  dep?: string;
}

const ll = (s: string | null): LngLat | null => {
  const p = (s ?? '').split(',').map(Number);
  return p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90 ? [p[0], p[1]] : null;
};

/** ?from=lng,lat&to=lng,lat&dep=HH:MM */
export function parseCommuteLink(search: string): CommuteLink | null {
  const q = new URLSearchParams(search);
  const from = ll(q.get('from')), to = ll(q.get('to'));
  if (!from || !to) return null;
  const dep = parseHHMM(q.get('dep')) ? q.get('dep')!.trim().padStart(5, '0') : undefined;
  return { from, to, dep };
}

/** The query string with the commute set (other parameters, such as pin, kept). */
export function commuteSearch(search: string, c: CommuteLink): string {
  const q = new URLSearchParams(search);
  const f = (p: LngLat) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
  q.set('from', f(c.from));
  q.set('to', f(c.to));
  if (c.dep) q.set('dep', c.dep);
  else q.delete('dep');
  return `?${q.toString().replace(/%2C/g, ',').replace(/%3A/g, ':')}`;
}
