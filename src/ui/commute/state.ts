// My commute: what the commuter keeps (home, office, usual departure, an optional return trip), the
// share link and the saved copy. The link extends the pincode view's ?from&to&dep (src/commute/verdict.ts):
//   ?commute=1&from=lng,lat&to=lng,lat&dep=HH:MM[&ret=HH:MM][&fromName=..][&toName=..]
// `commute` opens the Commute tab; the rest is the trip. No DOM here (node tests run it).
import type { LngLat } from '../../commute/spots.ts';
import { commuteSearch, istParts, nextWeekdayAt, parseCommuteLink, parseHHMM } from '../../commute/verdict.ts';
import { load, save } from '../store.ts';

export interface CommutePlace {
  /** what the commuter sees, e.g. "Indiranagar" or "My location" */
  label: string;
  coord: LngLat;
}

export interface CommuteState {
  home: CommutePlace | null;
  office: CommutePlace | null;
  /** usual departure from home, "HH:MM" IST */
  dep: string;
  /** departure from the office for the way back, "HH:MM" IST; null = no return trip */
  ret: string | null;
}

export const MORNING = '09:00';
export const EVENING = '18:00';
export const DEFAULT_STATE: CommuteState = { home: null, office: null, dep: MORNING, ret: null };
/** every query parameter the Commute tab owns (dropped when the reader goes back to Explore) */
export const COMMUTE_PARAMS = ['commute', 'from', 'to', 'dep', 'ret', 'fromName', 'toName'] as const;
const STORE_KEY = 'commute.v1';
/** Bengaluru and its commuter belt, generously: [west, south, east, north] */
const AREA: [number, number, number, number] = [76.9, 12.4, 78.3, 13.6];

/** "9:5" / " 09:05 " -> "09:05"; anything else -> null */
export function cleanHHMM(s: string | null | undefined): string | null {
  const p = parseHHMM(s);
  return p ? `${String(p[0]).padStart(2, '0')}:${String(p[1]).padStart(2, '0')}` : null;
}

/** the Morning / Evening preset a time matches, or null for any other time */
export const presetOf = (hhmm: string): 'am' | 'pm' | null => (hhmm === MORNING ? 'am' : hhmm === EVENING ? 'pm' : null);

const cleanLabel = (s: unknown, fallback: string): string => {
  const t = typeof s === 'string' ? s.replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  return t || fallback;
};
const cleanCoord = (c: unknown): LngLat | null => {
  if (!Array.isArray(c) || c.length !== 2) return null;
  const [x, y] = c.map(Number);
  return Number.isFinite(x) && Number.isFinite(y) && x >= AREA[0] && x <= AREA[2] && y >= AREA[1] && y <= AREA[3] ? [x, y] : null;
};
const cleanPlace = (p: unknown, fallback: string): CommutePlace | null => {
  const coord = cleanCoord((p as CommutePlace | null)?.coord);
  return coord ? { label: cleanLabel((p as CommutePlace).label, fallback), coord } : null;
};

/** Anything (a stored object, a parsed link) -> a valid state; bad parts fall back to the defaults. */
export function sanitize(x: unknown): CommuteState {
  const s = (x && typeof x === 'object' ? x : {}) as Partial<Record<keyof CommuteState, unknown>>;
  return {
    home: cleanPlace(s.home, 'Home'),
    office: cleanPlace(s.office, 'Office'),
    dep: cleanHHMM(typeof s.dep === 'string' ? s.dep : null) ?? DEFAULT_STATE.dep,
    ret: s.ret === null || s.ret === undefined ? null : cleanHHMM(String(s.ret)),
  };
}

/** The commute a link carries, or null when it has no ?commute. A link without from/to opens an empty card. */
export function stateFromSearch(search: string): CommuteState | null {
  const q = new URLSearchParams(search);
  if (!q.has('commute')) return null;
  const link = parseCommuteLink(search);
  return sanitize({
    home: link ? { label: q.get('fromName'), coord: link.from } : null,
    office: link ? { label: q.get('toName'), coord: link.to } : null,
    dep: link?.dep ?? q.get('dep'),
    ret: q.get('ret'),
  });
}

/** True when the link names a trip (from and to), i.e. it should replace what is saved. */
export const linkHasTrip = (search: string): boolean => new URLSearchParams(search).has('commute') && !!parseCommuteLink(search);

/** The query string of a share link for this commute (other parameters, such as packs, kept; pin dropped). */
export function shareSearch(search: string, s: CommuteState): string {
  const q = new URLSearchParams(search);
  for (const k of COMMUTE_PARAMS) q.delete(k);
  q.delete('pin');
  q.set('commute', '1');
  let out = `?${q.toString()}`;
  if (s.home && s.office) out = commuteSearch(out, { from: s.home.coord, to: s.office.coord, dep: s.dep });
  const extra = new URLSearchParams(out);
  if (!s.home || !s.office) extra.set('dep', s.dep);
  if (s.ret) extra.set('ret', s.ret);
  if (s.home && s.home.label !== 'Home') extra.set('fromName', s.home.label);
  if (s.office && s.office.label !== 'Office') extra.set('toName', s.office.label);
  return `?${extra.toString().replace(/%2C/g, ',').replace(/%3A/g, ':')}`;
}

/** The query string with every commute parameter removed (going back to Explore). */
export function withoutCommute(search: string): string {
  const q = new URLSearchParams(search);
  for (const k of COMMUTE_PARAMS) q.delete(k);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function loadState(): CommuteState {
  return sanitize(load<unknown>(STORE_KEY, null));
}

export function saveState(s: CommuteState): void {
  save(STORE_KEY, s);
}

/** A trip leg: which way, and when it next leaves (the next Monday-Friday at that time, IST). */
export interface Leg {
  id: 'out' | 'back';
  from: CommutePlace;
  to: CommutePlace;
  hhmm: string;
  departure: number;
}

/** The legs of a complete commute, the one that leaves soonest first; [] until home and office are set. */
export function legs(s: CommuteState, now: number): Leg[] {
  if (!s.home || !s.office) return [];
  const at = (hhmm: string) => {
    const [h, m] = parseHHMM(hhmm) ?? [9, 0];
    // a departure in the last 20 minutes is still "today's": the reader is probably on the way
    return nextWeekdayAt(now - 20 * 60e3, h, m);
  };
  const out: Leg[] = [{ id: 'out', from: s.home, to: s.office, hhmm: s.dep, departure: at(s.dep) }];
  if (s.ret) out.push({ id: 'back', from: s.office, to: s.home, hhmm: s.ret, departure: at(s.ret) });
  return out.sort((a, b) => a.departure - b.departure);
}

/** "today", "tomorrow" or the weekday, for a departure (IST) */
export function dayWord(t: number, now: number): string {
  const day = (x: number) => Math.floor((x + 5.5 * 3600e3) / 86400e3);
  const d = day(t) - day(now);
  if (d <= 0) return 'today';
  if (d === 1) return 'tomorrow';
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][istParts(t).day];
}
