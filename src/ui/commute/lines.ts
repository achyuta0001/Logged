// Short plain-language lines from the plan (src/commute/plan.ts) for the Commute tab: the update
// banner when a re-check changes the advice for the same trip, the reason under each route card, and
// the text of the share card (src/ui/commute/card.ts draws it). Pure, no DOM (node tests run it).
import type { CommutePlan, RiskLevel, RouteCandidate, RouteRisk } from '../../commute/types.ts';
import { BUCKET_MS } from '../../commute/config.ts';
import { fmtHHMM, istParts } from '../../commute/verdict.ts';
import { rank } from './levels.ts';

/** a likely-or-worse window (first and last half-hour bucket, ms) as "09:00–10:00" IST */
export const windowText = (w: [number, number]): string => `${fmtHHMM(w[0])}–${fmtHHMM(w[1] + BUCKET_MS)}`;

/** a travel time as the route cards show it: "32 min", "1 h 05" */
export const fmtMin = (s: number): string => {
  const m = Math.max(1, Math.round(s / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
};
export const fmtKm = (m: number): string => `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;

/**
 * The banner after a re-check changed the advice for the same trip, e.g.
 * "Update: now Leave by 08:15 — Silk Board Junction likely waterlogged 09:00–10:00".
 * The detail names the first hotspot behind the advice, when it has a window.
 */
export function updateLine(
  headline: string,
  plan: Pick<CommutePlan, 'drivers'>,
  nameOf: (id: string) => string,
  windowOf: (id: string) => [number, number] | null | undefined,
): string {
  const id = plan.drivers[0];
  const w = id ? windowOf(id) : null;
  return `Update: now ${headline}${id && w ? ` — ${nameOf(id)} likely waterlogged ${windowText(w)}` : ''}`;
}

/** a route's hotspots with water expected (watch or worse), worst first, in travel order within a level */
const wet = (rk: RouteRisk | undefined) => (rk?.hits ?? []).filter((h) => rank(h.level) > 0).sort((a, b) => rank(b.level) - rank(a.level));
/** "Silk Board Junction", "Silk Board Junction and 2 more" */
const andMore = (ids: string[], nameOf: (id: string) => string) => `${nameOf(ids[0])}${ids.length > 1 ? ` and ${ids.length - 1} more` : ''}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** what a route meets: the hotspot likely waterlogged (a count when several, easier to compare across cards), else how many could be, else none */
function meets(rk: RouteRisk | undefined, nameOf: (id: string) => string): string {
  const w = wet(rk);
  const bad = w.filter((h) => rank(h.level) >= rank('likely'));
  if (bad.length) return `${bad.length === 1 ? nameOf(bad[0].id) : `${bad.length} spots`} likely waterlogged`;
  if (w.length) return `passes ${w.length} watch spot${w.length === 1 ? '' : 's'}`;
  return 'no waterlogging expected';
}

/**
 * The line under a route card: how it differs from the fastest route, e.g. "Fastest · passes 2 watch
 * spots" or "Avoids Silk Board Junction · 4 min longer". Any other route gives its extra time (in the
 * whole minutes the cards show) after either the hotspots with water expected that it misses on the
 * fastest one (only when it is less risky and itself at most watch) or the ones it meets itself.
 * `covered` false (no rain forecast for the trip yet) leaves the water out: no forecast is never
 * "no waterlogging".
 */
export function routeReason(
  id: RouteCandidate['id'],
  routes: Pick<RouteCandidate, 'id' | 'durationS'>[],
  risks: RouteRisk[],
  nameOf: (id: string) => string,
  covered = true,
): string {
  const r = routes.find((x) => x.id === id);
  if (!r) return '';
  const fast = routes.reduce((a, b) => (b.durationS < a.durationS ? b : a));
  const riskOf = (x: string) => risks.find((k) => k.route === x);
  const rk = riskOf(id);
  if (r === fast) {
    const head = routes.length > 1 ? 'Fastest' : 'Only route found';
    return covered ? `${head} · ${meets(rk, nameOf)}` : head;
  }
  const extra = Math.max(1, Math.round(r.durationS / 60)) - Math.max(1, Math.round(fast.durationS / 60));
  const cost = extra > 0 ? `${fmtMin(extra * 60)} longer` : 'about as fast';
  if (!covered) return cap(cost);
  const fk = riskOf(fast.id);
  const mine = new Set((rk?.hits ?? []).map((h) => h.id));
  const missed = wet(fk).filter((h) => !mine.has(h.id));
  const own = rank(rk?.level ?? 'clear');
  if (missed.length && own < rank('likely') && own < rank(fk?.level ?? 'clear')) return `Avoids ${andMore(missed.map((h) => h.id), nameOf)} · ${cost}`;
  return `${cap(meets(rk, nameOf))} · ${cost}`;
}

// ---------------------------------------------------------------- share card

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** the IST calendar day of a time: "Wednesday 22 Oct" (short: "Wed 22 Oct"), the same in every browser */
const dayText = (t: number, short = false) => {
  const d = new Date(t + 5.5 * 3600e3);
  const wd = WEEKDAY[istParts(t).day];
  return `${short ? wd.slice(0, 3) : wd} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
};

/** "12.9719, 77.6412": a picked point with no place name */
const COORDS = /^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/;

/** an end of the trip as the card names it: no "Near " or "My location · ", and never raw coordinates (where someone lives stays off a shared picture) */
export function placeName(label: string, fallback: string): string {
  const t = label.replace(/^(Near|My location ·) /, '').trim();
  return !t || COORDS.test(t) ? fallback : t;
}

/**
 * An end of the trip on the card: home and office by their place ("Indiranagar"; "Home" for a bare
 * point), a saved place by the reader's own name for it ("Gym"), never by where it is; a name that
 * is only coordinates shows as "Place".
 */
export function cardEnd(e: { id: string; label: string }): string {
  if (e.id === 'home' || e.id === 'office') return placeName(e.label, e.id === 'home' ? 'Home' : 'Office');
  const t = e.label.trim();
  return !t || COORDS.test(t) ? 'Place' : t;
}

/** the card's date line, "Wednesday 22 Oct · leaving 08:30": a date, not "tomorrow", as the picture is read later */
export const cardWhen = (departure: number): string => `${dayText(departure)} · leaving ${fmtHHMM(departure)}`;

/** when the prediction on the card was made, "Checked 18:05, Tue 21 Oct" */
export const checkedText = (now: number): string => `Checked ${fmtHHMM(now)}, ${dayText(now, true)}`;

/** the card's file name, "commute-2026-10-22-0830.png" (IST) */
export function cardFile(departure: number): string {
  const d = new Date(departure + 5.5 * 3600e3);
  const p = (n: number) => String(n).padStart(2, '0');
  return `commute-${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${fmtHHMM(departure).replace(':', '')}.png`;
}

export interface CardSpot {
  name: string;
  /** level when the commuter reaches it */
  level: RiskLevel;
  /** the likely-or-worse window "09:00–10:00", or for a watch spot when it is reached, "around 09:10" */
  when: string;
}

/**
 * The hotspots the share card names, at most `max`: the ones behind the advice first, then any other
 * with water expected on the best route (worst first). Each is taken where it is met: on the best
 * route when it lies there, else on the first route that passes it.
 */
export function cardSpots(
  plan: Pick<CommutePlan, 'departure' | 'routes' | 'drivers'>,
  best: RouteCandidate['id'] | null,
  nameOf: (id: string) => string,
  windowOf: (id: string) => [number, number] | null | undefined,
  max = 3,
): CardSpot[] {
  const on = plan.routes.find((r) => r.route === best);
  const hitOf = (id: string) => on?.hits.find((h) => h.id === id) ?? plan.routes.flatMap((r) => r.hits).find((h) => h.id === id);
  const out: CardSpot[] = [];
  for (const id of new Set([...plan.drivers, ...wet(on).map((h) => h.id)])) {
    const h = hitOf(id);
    if (!h || rank(h.level) === 0) continue;
    const w = rank(h.level) >= rank('likely') ? windowOf(id) : null;
    out.push({ name: nameOf(id), level: h.level, when: w ? windowText(w) : `around ${fmtHHMM(plan.departure + h.atS * 1000)}` });
    if (out.length === max) break;
  }
  return out;
}
