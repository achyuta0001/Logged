// Saved places in My commute besides home and office ("Gym", "School", "Parents"): at most
// MAX_PLACES, each the reader's name for it, where it is (as the place search, the map or the
// reader's location put it) and the point. Kept on this device (src/ui/commute/state.ts saves them);
// a share link carries one only as an end of the trip it shares. Pure list operations, no DOM (node
// tests run them): each returns a new list, or the same list when nothing changed.
import type { LngLat } from '../../commute/spots.ts';
import { placeName } from './lines.ts';

export const MAX_PLACES = 5;
/** the longest name or place text kept */
export const MAX_LABEL = 60;
/** Bengaluru and its commuter belt, generously: [west, south, east, north] */
const AREA: [number, number, number, number] = [76.9, 12.4, 78.3, 13.6];

export interface SavedPlace {
  /** "p1", "p2", ...: stable while the place is kept; the trip's ends and the panel's rows go by it */
  id: string;
  /** the reader's name for it, e.g. "Gym" */
  label: string;
  /** where it is, as the search, the map or the location put it: "Indiranagar", "Near Koramangala" */
  where: string;
  coord: LngLat;
}

/** one line of plain text: no control characters (tabs and line breaks become spaces) or angle brackets, spaces collapsed, at most MAX_LABEL characters; empty -> the fallback */
export function cleanLabel(s: unknown, fallback: string): string {
  const t =
    typeof s === 'string'
      ? s
          .replace(/[\u0000-\u001f<>]/g, (c) => (/\s/.test(c) ? ' ' : ''))
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, MAX_LABEL)
          .trim()
      : '';
  return t || fallback;
}

/** a [lng, lat] inside the area, or null */
export function cleanCoord(c: unknown): LngLat | null {
  if (!Array.isArray(c) || c.length !== 2) return null;
  const [x, y] = c.map(Number);
  return Number.isFinite(x) && Number.isFinite(y) && x >= AREA[0] && x <= AREA[2] && y >= AREA[1] && y <= AREA[3] ? [x, y] : null;
}

const fold = (s: string) => s.trim().toLowerCase();

/** `name`, else "name 2", "name 3", ...: the first that is not in `taken` (case and outer spaces ignored) */
export function uniqueLabel(name: string, taken: Iterable<string>): string {
  const t = new Set([...taken].map(fold));
  if (!t.has(fold(name))) return name;
  for (let n = 2; ; n++) {
    const tail = ` ${n}`;
    const s = `${name.slice(0, MAX_LABEL - tail.length).trimEnd()}${tail}`;
    if (!t.has(fold(s))) return s;
  }
}

/** the name a new place starts with: its area ("Near Koramangala" -> "Koramangala"), "Place" for a bare point */
export const defaultLabel = (where: string): string => placeName(where, 'Place');

/** the id for a new place: the first of p1, p2, ... not in use */
export function nextId(places: Pick<SavedPlace, 'id'>[]): string {
  for (let n = 1; ; n++) if (!places.some((p) => p.id === `p${n}`)) return `p${n}`;
}

/** the names a place may not take: home's, office's and every other saved place's */
const takenBy = (places: SavedPlace[], except?: string) => ['Home', 'Office', ...places.filter((p) => p.id !== except).map((p) => p.label)];

/**
 * Anything (the saved copy) -> at most MAX_PLACES valid places, in order: one without a point in
 * the area is dropped, a missing or repeated id is replaced, names are cleaned and made unique.
 */
export function cleanPlaces(x: unknown): SavedPlace[] {
  const out: SavedPlace[] = [];
  if (!Array.isArray(x)) return out;
  for (const item of x) {
    if (out.length === MAX_PLACES) break;
    const p = (item && typeof item === 'object' ? item : {}) as Partial<Record<keyof SavedPlace, unknown>>;
    const coord = cleanCoord(p.coord);
    if (!coord) continue;
    const where = cleanLabel(p.where, `${coord[1].toFixed(4)}, ${coord[0].toFixed(4)}`);
    const id = typeof p.id === 'string' && /^p\d{1,2}$/.test(p.id) && !out.some((q) => q.id === p.id) ? p.id : nextId(out);
    out.push({ id, label: uniqueLabel(cleanLabel(p.label, defaultLabel(where)), takenBy(out)), where, coord });
  }
  return out;
}

/**
 * The list with a new place at the end: named `label` when one is given, else after its area; the
 * same list when it is full or the point lies outside the area.
 */
export function addPlace(places: SavedPlace[], where: string, coord: LngLat, label?: string): SavedPlace[] {
  const c = cleanCoord(coord);
  if (!c || places.length >= MAX_PLACES) return places;
  const w = cleanLabel(where, `${c[1].toFixed(4)}, ${c[0].toFixed(4)}`);
  return [...places, { id: nextId(places), label: uniqueLabel(cleanLabel(label, defaultLabel(w)), takenBy(places)), where: w, coord: c }];
}

/** The list with one place renamed (cleaned, unique among home, office and the rest); an empty name keeps the old one. */
export function renamePlace(places: SavedPlace[], id: string, label: string): SavedPlace[] {
  const p = places.find((x) => x.id === id);
  if (!p) return places;
  const name = uniqueLabel(cleanLabel(label, p.label), takenBy(places, id));
  return name === p.label ? places : places.map((x) => (x === p ? { ...x, label: name } : x));
}

/** The list with one place moved to a new point (its name stays); the same list for a point outside the area. */
export function movePlace(places: SavedPlace[], id: string, where: string, coord: LngLat): SavedPlace[] {
  const c = cleanCoord(coord);
  const p = places.find((x) => x.id === id);
  if (!c || !p) return places;
  return places.map((x) => (x === p ? { ...x, where: cleanLabel(where, `${c[1].toFixed(4)}, ${c[0].toFixed(4)}`), coord: c } : x));
}

/** The list without one place. */
export function removePlace(places: SavedPlace[], id: string): SavedPlace[] {
  return places.some((p) => p.id === id) ? places.filter((p) => p.id !== id) : places;
}
