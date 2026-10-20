// Commute planner: candidate routes + a departure time + hotspot outlooks -> each route's level and
// one piece of advice (go / leave by / leave after / take another route / work from home). Pure,
// no DOM, no network; the numbers are in config.ts (PLAN). Times are ms epoch, clocks IST.
//
// A hotspot is on a route when it lies within PLAN.bufferM of the route line. The commuter reaches it
// at departure + atS, where atS interpolates the route's cumS (seconds from the start at each vertex)
// at the closest point. Its level then is the level of the 30-minute bucket containing that moment,
// and a route takes the worst level among its hotspots. Wording is short and always advisory.
import type { Advice, CommuteHotspot, CommutePlan, HotspotOutlook, RiskLevel, RouteCandidate, RouteHotspotHit, RouteRisk } from './types.ts';
import { PLAN } from './config.ts';
import { atLeast, LEVEL_RANK, levelAt, worstLevel } from './risk.ts';
import { fmtHHMM } from './verdict.ts';

const MIN = 60e3;
export const ADVISORY = 'Advisory only.';

/** A hotspot met along a route. distanceM is metres along the route from the start (like atS, in distance); offM is metres from the hotspot to the line. */
export type PlanHit = RouteHotspotHit & { offM: number };

/** Hotspots within `bufferM` of the route line, in travel order, with when (atS) and where (distanceM along) they are reached. */
export function routeHits(route: Pick<RouteCandidate, 'line' | 'cumS'>, hotspots: Pick<CommuteHotspot, 'id' | 'coord'>[], bufferM = PLAN.bufferM): PlanHit[] {
  const L = route.line;
  if (L.length < 2 || !hotspots.length) return [];
  const lat0 = L.reduce((s, c) => s + c[1], 0) / L.length;
  const KX = 111320 * Math.cos((lat0 * Math.PI) / 180), KY = 110574;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of L) {
    w = Math.min(w, x);
    e = Math.max(e, x);
    s = Math.min(s, y);
    n = Math.max(n, y);
  }
  const padX = bufferM / KX, padY = bufferM / KY;
  const cum = route.cumS.length === L.length ? route.cumS : null;
  const out: PlanHit[] = [];
  for (const h of hotspots) {
    const [px, py] = h.coord;
    if (px < w - padX || px > e + padX || py < s - padY || py > n + padY) continue;
    let best = Infinity, bestAlong = 0, bestS = 0, along = 0;
    for (let i = 0; i + 1 < L.length; i++) {
      const ax = (L[i][0] - px) * KX, ay = (L[i][1] - py) * KY;
      const dx = (L[i + 1][0] - L[i][0]) * KX, dy = (L[i + 1][1] - L[i][1]) * KY;
      const L2 = dx * dx + dy * dy, len = Math.sqrt(L2);
      const u = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      const d = Math.hypot(ax + u * dx, ay + u * dy);
      if (d < best) {
        best = d;
        bestAlong = along + u * len;
        bestS = cum ? cum[i] + u * (cum[i + 1] - cum[i]) : NaN;
      }
      along += len;
    }
    if (best > bufferM) continue;
    // without cumS, time is pro rata along the line (the caller should pass cumS)
    const atS = Number.isFinite(bestS) ? bestS : 0;
    out.push({ id: h.id, atS: Math.round(atS), distanceM: Math.round(bestAlong), offM: Math.round(best) });
  }
  return out.sort((a, b) => a.distanceM - b.distanceM);
}

/** One route at one departure: each hit's level when reached, and the worst. `unknown` = some hit falls outside the outlooks. */
export function routeRisk(route: Pick<RouteCandidate, 'id'>, hits: PlanHit[], outlooks: Map<string, HotspotOutlook>, departure: number): RouteRisk & { unknown: boolean } {
  let level: RiskLevel = 'clear', unknown = false;
  const out = hits.map((h) => {
    const l = levelAt(outlooks.get(h.id), departure + h.atS * 1000);
    if (l === null) unknown = true;
    const lv = l ?? 'clear';
    level = worstLevel(level, lv);
    return { ...h, level: lv };
  });
  return { route: route.id, level, hits: out, unknown };
}

const ok = (l: RiskLevel) => !atLeast(l, 'likely');

/** "Silk Board Junction", "Silk Board Junction and Hebbal Flyover", "A, B and 2 more" */
function names(ids: string[], nameOf: (id: string) => string): string {
  const ns = [...new Set(ids)].map(nameOf);
  if (ns.length <= 2) return ns.join(' and ');
  return `${ns[0]}, ${ns[1]} and ${ns.length - 2} more`;
}

const roundDown = (t: number, m: number) => Math.floor(t / (m * MIN)) * m * MIN;
const roundUp = (t: number, m: number) => Math.ceil(t / (m * MIN)) * m * MIN;

/**
 * The plan for `departure`. Routes are in the router's order (A first, the usual choice). Advice:
 *  - go          route A is clear or watch at this departure;
 *  - otherwise the least disruptive of: use_route (another route clear or watch now, cost = its extra
 *    minutes), leave_by (the latest earlier departure on route A that is clear or watch, less
 *    PLAN.marginMin, not before now), leave_after (the first later one, plus the margin), each searched
 *    within PLAN.rangeH;
 *  - wfh         every route is likely or worse at every departure in that range.
 */
export function planCommute(
  routes: RouteCandidate[],
  hotspots: Pick<CommuteHotspot, 'id' | 'coord' | 'name'>[],
  outlookList: HotspotOutlook[] | Map<string, HotspotOutlook>,
  departure: number,
  now = Date.now(),
): CommutePlan {
  const outlooks = outlookList instanceof Map ? outlookList : new Map(outlookList.map((o) => [o.id, o]));
  const nameById = new Map(hotspots.map((h) => [h.id, h.name]));
  const nameOf = (id: string) => nameById.get(id) ?? id;
  const hitsBy = routes.map((r) => routeHits(r, hotspots));
  const at = (k: number, dep: number) => routeRisk(routes[k], hitsBy[k], outlooks, dep);
  /** clear or watch, and every hotspot on it inside the outlooks (no forecast is never "fine") */
  const okAt = (k: number, dep: number) => {
    const r = at(k, dep);
    return ok(r.level) && !r.unknown;
  };
  const risks = routes.map((_, k) => at(k, departure));
  const plan = (advice: Advice, drivers: string[]): CommutePlan => ({ departure, routes: risks.map(({ unknown: _u, ...r }) => r), advice, drivers: [...new Set(drivers)] });

  if (!routes.length) return plan({ kind: 'go', text: `No route to check. ${ADVISORY}` }, []);
  const A = risks[0];
  const bad = (r: RouteRisk) => r.hits.filter((h) => atLeast(h.level, 'likely'));
  const watch = A.hits.filter((h) => h.level === 'watch');
  const when = (h: { atS: number }) => fmtHHMM(departure + h.atS * 1000);

  if (ok(A.level)) {
    if (!A.hits.length) return plan({ kind: 'go', text: `Go: no flood hotspot lies on route ${A.route}. ${ADVISORY}` }, []);
    if (A.hits.every((h) => levelAt(outlooks.get(h.id), departure + h.atS * 1000) === null))
      return plan({ kind: 'go', text: `No rain forecast covers ${fmtHHMM(departure)} yet; check again nearer the time. ${ADVISORY}` }, []);
    if (watch.length) return plan({ kind: 'go', text: `Go, but watch ${names(watch.map((h) => h.id), nameOf)} (rain near ${when(watch[0])}). ${ADVISORY}` }, watch.map((h) => h.id));
    return plan({ kind: 'go', text: `Go: no hotspot on route ${A.route} is expected to waterlog on the way. ${ADVISORY}` }, []);
  }

  const drivers = bad(A).map((h) => h.id);
  const first = bad(A)[0];
  const step = PLAN.stepMin * MIN, margin = PLAN.marginMin * MIN, range = PLAN.rangeH * 3600e3;
  const options: { cost: number; advice: Advice; drivers: string[] }[] = [];

  // another route at the same time
  const alt = risks
    .map((r, k) => ({ r, k }))
    .slice(1)
    .filter(({ r }) => ok(r.level))
    .sort((a, b) => LEVEL_RANK[a.r.level] - LEVEL_RANK[b.r.level] || routes[a.k].durationS - routes[b.k].durationS)[0];
  if (alt) {
    const extra = Math.max(0, routes[alt.k].durationS - routes[0].durationS);
    const via = routes[alt.k].via ? ` ${routes[alt.k].via}` : '';
    options.push({
      cost: extra * 1000,
      drivers,
      advice: { kind: 'use_route', route: routes[alt.k].id, text: `Take route ${routes[alt.k].id}${via}: route ${A.route} passes ${names(drivers, nameOf)}, likely waterlogged around ${when(first)}. ${ADVISORY}` },
    });
  }

  // leave earlier on route A: the latest departure that works, less the margin (never before now)
  const earliest = Math.max(now, departure - range);
  for (let d = roundDown(departure - step, PLAN.stepMin); d >= earliest; d -= step) {
    if (!okAt(0, d)) continue;
    const by = Math.max(roundUp(earliest, PLAN.stepMin), roundDown(d - margin, PLAN.stepMin));
    if (by > d || !okAt(0, by)) continue;
    const start = outlooks.get(first.id)?.window?.[0];
    const from = start ? ` from about ${fmtHHMM(start)}` : '';
    options.push({ cost: departure - by, drivers, advice: { kind: 'leave_by', at: by, text: `Leave by ${fmtHHMM(by)}: ${names(drivers, nameOf)} is likely waterlogged${from}. ${ADVISORY}` } });
    break;
  }

  // leave later on route A: the first departure that works, plus the margin
  for (let d = roundUp(departure + step, PLAN.stepMin); d <= departure + range; d += step) {
    if (!okAt(0, d)) continue;
    const after = roundUp(d + margin, PLAN.stepMin);
    if (!okAt(0, after)) continue;
    options.push({ cost: after - departure, drivers, advice: { kind: 'leave_after', at: after, text: `Leave after ${fmtHHMM(after)}: ${names(drivers, nameOf)} is likely waterlogged until then. ${ADVISORY}` } });
    break;
  }

  if (options.length) {
    const order: Record<Advice['kind'], number> = { use_route: 0, leave_by: 1, leave_after: 2, go: 3, wfh: 4 };
    options.sort((a, b) => a.cost - b.cost || order[a.advice.kind] - order[b.advice.kind]);
    return plan(options[0].advice, options[0].drivers);
  }

  // any route at any departure in range?
  for (let d = roundDown(earliest, PLAN.stepMin); d <= departure + range; d += step) {
    for (let k = 1; k < routes.length; k++) {
      if (!okAt(k, d)) continue;
      const t = fmtHHMM(d);
      return plan(
        { kind: 'use_route', route: routes[k].id, text: `Take route ${routes[k].id}${routes[k].via ? ` ${routes[k].via}` : ''}, leaving at ${t}: route ${A.route} passes ${names(drivers, nameOf)}, likely waterlogged. ${ADVISORY}` },
        drivers,
      );
    }
  }

  const allBad = risks.flatMap((r) => bad(r).map((h) => h.id));
  const lo = fmtHHMM(earliest), hi = fmtHHMM(departure + range);
  return plan({ kind: 'wfh', text: `Every route is likely waterlogged for departures from ${lo} to ${hi} (${names(allBad, nameOf)}). Consider working from home or waiting. ${ADVISORY}` }, allBad);
}
