// My commute: what the commuter keeps (home, office, usual departure, an optional return trip, up to
// five more saved places and the trip checked), the share link and the saved copy. The link extends
// the pincode view's ?from&to&dep (src/commute/verdict.ts):
//   ?commute=1&from=lng,lat&to=lng,lat&dep=HH:MM[&ret=HH:MM][&days=12345][&fromName=..][&toName=..]
// `commute` opens the Commute tab; the rest is the trip (`days`: commute days, 1 = Monday ... 7 = Sunday).
// The link carries only the two ends of the trip checked, never the other saved places; whoever opens
// it gets that trip as home -> office. No DOM here (node tests run it).
import type { LngLat } from '../../commute/spots.ts';
import { commuteSearch, istParts, parseCommuteLink, parseHHMM } from '../../commute/verdict.ts';
import { load, save } from '../store.ts';
import { cleanCoord, cleanLabel, cleanPlaces, removePlace, type SavedPlace } from './places.ts';

export type { SavedPlace } from './places.ts';

export interface CommutePlace {
  /** what the commuter sees, e.g. "Indiranagar" or "My location" */
  label: string;
  coord: LngLat;
}

/** an end of a trip: 'home', 'office' or a saved place's id ("p1") */
export type EndId = string;

/** when a trip is made: the departure, the way back (null = none) and the days, as in CommuteState */
export interface Times {
  dep: string;
  ret: string | null;
  days: string;
}

export interface CommuteState {
  home: CommutePlace | null;
  office: CommutePlace | null;
  /** usual departure from home, "HH:MM" IST */
  dep: string;
  /** departure from the office for the way back, "HH:MM" IST; null = no return trip */
  ret: string | null;
  /** the days the commute is made: ISO weekday digits in order, 1 = Monday ... 7 = Sunday, e.g. "12345" */
  days: string;
  /** up to five more places ("Gym"), kept on this device */
  places: SavedPlace[];
  /** the trip checked; home -> office (the commute, timed by dep / ret / days above) unless the reader picks others */
  from: EndId;
  to: EndId;
  /** the times of every other trip the reader has set, by "from>to", e.g. "home>p1" */
  trips: Record<string, Times>;
}

export const MORNING = '09:00';
export const EVENING = '18:00';
/** Monday to Friday */
export const WEEKDAYS = '12345';
export const DEFAULT_STATE: CommuteState = { home: null, office: null, dep: MORNING, ret: null, days: WEEKDAYS, places: [], from: 'home', to: 'office', trips: {} };
/** every query parameter the Commute tab owns (dropped when the reader goes back to Explore) */
export const COMMUTE_PARAMS = ['commute', 'from', 'to', 'dep', 'ret', 'days', 'fromName', 'toName'] as const;
const STORE_KEY = 'commute.v1';
/** the saved places, the trip chosen and other trips' times: a key of their own, so that a tab still on an older version, which saves only the key above, cannot drop them */
const PLACES_KEY = 'commute.places.v1';
/** the commute: home -> office */
const COMMUTE = 'home>office';

/** "9:5" / " 09:05 " -> "09:05"; anything else -> null */
export function cleanHHMM(s: string | null | undefined): string | null {
  const p = parseHHMM(s);
  return p ? `${String(p[0]).padStart(2, '0')}:${String(p[1]).padStart(2, '0')}` : null;
}

/** "5,1,3" / [1, 3, 5] / "135" -> "135" (ISO weekday digits, each once, in order); none or nonsense -> Monday to Friday */
export function cleanDays(x: unknown): string {
  const raw = Array.isArray(x) ? x.join('') : typeof x === 'string' || typeof x === 'number' ? String(x) : '';
  const out = [...'1234567'].filter((d) => raw.includes(d)).join('');
  return out || WEEKDAYS;
}

/** the Morning / Evening preset a time matches, or null for any other time */
export const presetOf = (hhmm: string): 'am' | 'pm' | null => (hhmm === MORNING ? 'am' : hhmm === EVENING ? 'pm' : null);

const cleanPlace = (p: unknown, fallback: string): CommutePlace | null => {
  const coord = cleanCoord((p as CommutePlace | null)?.coord);
  return coord ? { label: cleanLabel((p as CommutePlace).label, fallback), coord } : null;
};
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** each other trip's times, where both ends are known and the departure is a time; the rest dropped */
function cleanTrips(x: unknown, ids: Set<string>): Record<string, Times> {
  const out: Record<string, Times> = {};
  if (!isObj(x)) return out;
  for (const [k, v] of Object.entries(x)) {
    const ends = k.split('>');
    if (ends.length !== 2 || !ids.has(ends[0]) || !ids.has(ends[1]) || ends[0] === ends[1] || k === COMMUTE || !isObj(v)) continue;
    const dep = cleanHHMM(typeof v.dep === 'string' ? v.dep : null);
    if (dep) out[k] = { dep, ret: v.ret === null || v.ret === undefined ? null : cleanHHMM(String(v.ret)), days: cleanDays(v.days) };
  }
  return out;
}

/** Anything (a stored object, a parsed link) -> a valid state; bad parts fall back to the defaults. */
export function sanitize(x: unknown): CommuteState {
  const s = (isObj(x) ? x : {}) as Partial<Record<keyof CommuteState, unknown>>;
  const places = cleanPlaces(s.places);
  const ids = new Set(['home', 'office', ...places.map((p) => p.id)]);
  let from = typeof s.from === 'string' && ids.has(s.from) ? s.from : 'home';
  let to = typeof s.to === 'string' && ids.has(s.to) ? s.to : 'office';
  if (from === to) [from, to] = ['home', 'office'];
  return {
    home: cleanPlace(s.home, 'Home'),
    office: cleanPlace(s.office, 'Office'),
    dep: cleanHHMM(typeof s.dep === 'string' ? s.dep : null) ?? DEFAULT_STATE.dep,
    ret: s.ret === null || s.ret === undefined ? null : cleanHHMM(String(s.ret)),
    days: cleanDays(s.days),
    places,
    from,
    to,
    trips: cleanTrips(s.trips, ids),
  };
}

// ---------------------------------------------------------------- the trip: its ends and times

/** an end of the trip with its point; `label`: home's and office's place ("Indiranagar"), a saved place's own name ("Gym") */
export interface TripEnd extends CommutePlace {
  id: EndId;
}

/** home, office or a saved place as an end of a trip; null while it has no point (or no longer exists) */
export function endOf(s: Pick<CommuteState, 'home' | 'office'> & Partial<Pick<CommuteState, 'places'>>, id: EndId): TripEnd | null {
  if (id === 'home' || id === 'office') {
    const p = s[id];
    return p ? { id, label: p.label, coord: p.coord } : null;
  }
  const p = s.places?.find((x) => x.id === id);
  return p ? { id, label: p.label, coord: p.coord } : null;
}

/** what the chips and rows call an end: "Home", "Office" or the saved place's name */
export function endLabel(s: Partial<Pick<CommuteState, 'places'>>, id: EndId): string {
  return id === 'home' ? 'Home' : id === 'office' ? 'Office' : (s.places?.find((p) => p.id === id)?.label ?? '');
}

/** the trip checked, "home>office" (older saved copies and links have no from / to: the commute) */
export const tripKey = (s: Partial<Pick<CommuteState, 'from' | 'to'>>): string => `${s.from ?? 'home'}>${s.to ?? 'office'}`;

/** the times set for a trip, if any: the commute's are dep / ret / days */
function setFor(s: Partial<CommuteState> & Pick<CommuteState, 'dep' | 'ret' | 'days'>, key: string): Times | undefined {
  return key === COMMUTE ? { dep: s.dep, ret: s.ret, days: s.days } : s.trips?.[key];
}

/**
 * The times of the trip checked. The commute (home -> office) keeps dep / ret / days; any other
 * trip its own once the reader sets them. Until then it starts as the same round trip seen from the
 * other end when the reverse trip has a way back (office -> home leaves at the commute's time back),
 * else at the commute's departure on its days, one way.
 */
export function timesOf(s: Partial<CommuteState> & Pick<CommuteState, 'dep' | 'ret' | 'days'>): Times {
  const key = tripKey(s);
  const own = setFor(s, key);
  if (own) return own;
  const [a, b] = key.split('>');
  const rev = setFor(s, `${b}>${a}`);
  if (rev?.ret) return { dep: rev.ret, ret: rev.dep, days: rev.days };
  return { dep: s.dep, ret: null, days: s.days };
}

/** The state with the checked trip's times changed: the commute's own fields, or that trip's entry. */
export function withTimes(s: CommuteState, p: Partial<Times>): CommuteState {
  const key = tripKey(s);
  const t = { ...timesOf(s), ...p };
  if (key === COMMUTE) return { ...s, dep: t.dep, ret: t.ret, days: t.days };
  return { ...s, trips: { ...s.trips, [key]: t } };
}

const known = (s: CommuteState, id: EndId) => id === 'home' || id === 'office' || s.places.some((p) => p.id === id);

/** The trip with one end changed; picking the place at the other end swaps the two. Unknown places change nothing. */
export function chooseEnd(s: CommuteState, which: 'from' | 'to', id: EndId): CommuteState {
  if (!known(s, id) || s[which] === id) return s;
  if (which === 'from') return { ...s, from: id, to: id === s.to ? s.from : s.to };
  return { ...s, to: id, from: id === s.from ? s.to : s.from };
}

/** the trip the other way round */
export const swapEnds = (s: CommuteState): CommuteState => ({ ...s, from: s.to, to: s.from });

/**
 * The state without a saved place. A trip that started or ended there takes home in its place (office
 * when the other end is home), and the times of trips to or from it go too.
 */
export function withoutPlace(s: CommuteState, id: EndId): CommuteState {
  const places = removePlace(s.places, id);
  if (places === s.places) return s;
  let { from, to } = s;
  if (from === id) from = to === 'home' ? 'office' : 'home';
  if (to === id) to = from === 'home' ? 'office' : 'home';
  const trips = Object.fromEntries(Object.entries(s.trips).filter(([k]) => !k.split('>').includes(id)));
  return { ...s, places, from, to, trips };
}

/** how the rows name an end: "home", "office", or a saved place by its name */
const word = (e: { id: EndId; label: string }) => (e.id === 'home' || e.id === 'office' ? e.id : e.label);
/** "To office", "To home", "To Gym" */
export const toWords = (e: { id: EndId; label: string }): string => `To ${word(e)}`;
/** "Back home", "Back to office", "Back to Gym" */
export const backWords = (e: { id: EndId; label: string }): string => (e.id === 'home' ? 'Back home' : `Back to ${word(e)}`);
/** "leave home at", "leave the office at", "leave Gym at" */
export const leaveWords = (e: { id: EndId; label: string }): string => `leave ${e.id === 'office' ? 'the office' : word(e)} at`;

/** the trip rows' words: the way there, the way back, and whose days ("To office" / "leave home at" ...) */
export function tripWords(s: CommuteState): { out: string; outAt: string; back: string; backAt: string; days: string } {
  const a = { id: s.from, label: endLabel(s, s.from) };
  const b = { id: s.to, label: endLabel(s, s.to) };
  return { out: toWords(b), outAt: leaveWords(a), back: backWords(a), backAt: leaveWords(b), days: tripKey(s) === COMMUTE ? 'you commute' : 'you go' };
}

// ---------------------------------------------------------------- the link

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
    days: q.get('days'),
  });
}

/** True when the link names a trip (from and to), i.e. it should replace what is saved. */
export const linkHasTrip = (search: string): boolean => new URLSearchParams(search).has('commute') && !!parseCommuteLink(search);

/**
 * What is saved with a link's trip in it: the trip becomes home -> office with its times, and is the
 * trip checked; the saved places and other trips' times stay. A link without a trip changes nothing.
 */
export function applyLink(saved: CommuteState, search: string): CommuteState {
  const l = linkHasTrip(search) ? stateFromSearch(search) : null;
  return l ? { ...saved, home: l.home, office: l.office, dep: l.dep, ret: l.ret, days: l.days, from: 'home', to: 'office' } : saved;
}

/**
 * The query string of a share link for the trip checked (other parameters, such as packs, kept; pin
 * dropped). Its two ends go in, by their names, and nothing about the other saved places.
 */
export function shareSearch(search: string, s: CommuteState): string {
  const q = new URLSearchParams(search);
  for (const k of COMMUTE_PARAMS) q.delete(k);
  q.delete('pin');
  q.set('commute', '1');
  let out = `?${q.toString()}`;
  const a = endOf(s, s.from ?? 'home'), b = endOf(s, s.to ?? 'office');
  const t = timesOf(s);
  if (a && b) out = commuteSearch(out, { from: a.coord, to: b.coord, dep: t.dep });
  const extra = new URLSearchParams(out);
  if (!a || !b) extra.set('dep', t.dep);
  if (t.ret) extra.set('ret', t.ret);
  if (t.days !== WEEKDAYS) extra.set('days', t.days);
  // the names only with the trip: whoever opens the link gets its ends as home and office
  if (a && b && a.label !== 'Home') extra.set('fromName', a.label);
  if (a && b && b.label !== 'Office') extra.set('toName', b.label);
  return `?${extra.toString().replace(/%2C/g, ',').replace(/%3A/g, ':')}`;
}

/** The query string with every commute parameter removed (going back to Explore). */
export function withoutCommute(search: string): string {
  const q = new URLSearchParams(search);
  for (const k of COMMUTE_PARAMS) q.delete(k);
  const s = q.toString();
  return s ? `?${s}` : '';
}

// ---------------------------------------------------------------- the saved copy (localStorage, guarded in src/ui/store.ts)

export function loadState(): CommuteState {
  const base = load<unknown>(STORE_KEY, null);
  const more = load<unknown>(PLACES_KEY, null);
  const m = isObj(more) ? more : {};
  return sanitize({ ...(isObj(base) ? base : {}), places: m.places, from: m.from, to: m.to, trips: m.trips });
}

export function saveState(s: CommuteState): void {
  const { places, from, to, trips, ...commute } = s;
  save(STORE_KEY, commute);
  save(PLACES_KEY, { places, from, to, trips });
}

// ---------------------------------------------------------------- legs

/**
 * The first hh:mm IST at or after `now` on a commute day (`days` as in CommuteState: "12345" = Monday
 * to Friday). Other days are skipped, so with Monday to Friday a Friday evening gives Monday.
 */
export function nextDayAt(now: number, h: number, m: number, days: string): number {
  const D = 24 * 3600e3, IST = 5.5 * 3600e3;
  const day0 = Math.floor((now + IST) / D) * D - IST; // IST midnight today
  const at = (k: number) => day0 + k * D + h * 3600e3 + m * 60e3;
  // eight days: today's time may have passed on the only commute day, which is then a week away
  for (let k = 0; k < 8; k++) {
    const t = at(k);
    if (t >= now && days.includes(String(istParts(t).day || 7))) return t;
  }
  return at(now <= at(0) ? 0 : 1);
}

/** A trip leg: which way, and when it next leaves (the next commute day at that time, IST). */
export interface Leg {
  id: 'out' | 'back';
  from: TripEnd;
  to: TripEnd;
  hhmm: string;
  departure: number;
}

/** The legs of the trip checked (there, and back when it has a way back), the one that leaves soonest first; [] until both ends are set. */
export function legs(s: CommuteState, now: number): Leg[] {
  const a = endOf(s, s.from ?? 'home'), b = endOf(s, s.to ?? 'office');
  if (!a || !b) return [];
  const t = timesOf(s);
  const at = (hhmm: string) => {
    const [h, m] = parseHHMM(hhmm) ?? [9, 0];
    // a departure in the last 20 minutes is still "today's": the reader is probably on the way
    return nextDayAt(now - 20 * 60e3, h, m, t.days);
  };
  const out: Leg[] = [{ id: 'out', from: a, to: b, hhmm: t.dep, departure: at(t.dep) }];
  if (t.ret) out.push({ id: 'back', from: b, to: a, hhmm: t.ret, departure: at(t.ret) });
  return out.sort((x, y) => x.departure - y.departure);
}

/** "today", "tomorrow" or the weekday, for a departure (IST) */
export function dayWord(t: number, now: number): string {
  const day = (x: number) => Math.floor((x + 5.5 * 3600e3) / 86400e3);
  const d = day(t) - day(now);
  if (d <= 0) return 'today';
  if (d === 1) return 'tomorrow';
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][istParts(t).day];
}
