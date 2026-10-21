// Short plain-language lines from the plan (src/commute/plan.ts) for the Commute tab: the update
// banner when a re-check changes the advice for the same trip, and the reason under each route card.
// Pure, no DOM (node tests run it).
import type { CommutePlan, RouteCandidate, RouteRisk } from '../../commute/types.ts';
import { BUCKET_MS } from '../../commute/config.ts';
import { fmtHHMM } from '../../commute/verdict.ts';
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
