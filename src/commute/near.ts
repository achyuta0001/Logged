// Where news-reported flood spots meet a route or a pincode. Pure geometry, no DOM.
import type { LngLat, NewsSpot } from './spots.ts';

export interface RouteSpot {
  spot: NewsSpot;
  /** metres from the spot to the route line */
  distM: number;
  /** metres along the route to the closest point (orders the list as you travel) */
  alongM: number;
}

/**
 * Spots within `maxM` of a route polyline, in travel order. Uses a local flat projection around
 * the route (accurate to well under 1 % over a commute).
 */
export function spotsNearRoute(coords: LngLat[], spots: NewsSpot[], maxM = 100): RouteSpot[] {
  if (coords.length < 2 || !spots.length) return [];
  const lat0 = coords.reduce((s, c) => s + c[1], 0) / coords.length;
  const KX = 111320 * Math.cos((lat0 * Math.PI) / 180), KY = 110574;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of coords) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  const padX = maxM / KX, padY = maxM / KY;
  const out: RouteSpot[] = [];
  for (const spot of spots) {
    const [px, py] = spot.coord;
    if (px < w - padX || px > e + padX || py < s - padY || py > n + padY) continue;
    let best = Infinity, bestAlong = 0, along = 0;
    for (let i = 0; i + 1 < coords.length; i++) {
      const ax = (coords[i][0] - px) * KX, ay = (coords[i][1] - py) * KY;
      const bx = (coords[i + 1][0] - px) * KX, by = (coords[i + 1][1] - py) * KY;
      const dx = bx - ax, dy = by - ay;
      const L2 = dx * dx + dy * dy;
      const L = Math.sqrt(L2);
      const u = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      const d = Math.hypot(ax + u * dx, ay + u * dy);
      if (d < best) {
        best = d;
        bestAlong = along + u * L;
      }
      along += L;
    }
    if (best <= maxM) out.push({ spot, distM: best, alongM: bestAlong });
  }
  return out.sort((a, b) => a.alongM - b.alongM);
}

/** Ray casting over every ring (holes and multipolygons work by the even-odd rule). */
export function pointInGeometry(p: LngLat, g: GeoJSON.Polygon | GeoJSON.MultiPolygon): boolean {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let inside = false;
  for (const poly of polys)
    for (const ring of poly)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
      }
  return inside;
}

/** Reported flood days per pincode: the sum of `count` over the spots inside each polygon. */
export function reportsByArea<K>(areas: { key: K; geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon }[], spots: NewsSpot[]): Map<K, { spots: number; reports: number }> {
  const out = new Map<K, { spots: number; reports: number }>();
  for (const a of areas) {
    let spotsIn = 0, reports = 0;
    for (const s of spots)
      if (pointInGeometry(s.coord, a.geometry)) {
        spotsIn++;
        reports += s.count;
      }
    if (spotsIn) out.set(a.key, { spots: spotsIn, reports });
  }
  return out;
}
