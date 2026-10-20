// The commute hotspot registry (public/data/commute/hotspots.geojson, built by
// scripts/commute/build-hotspots.mjs): a Point feature per hotspot with the CommuteHotspot fields as
// properties. Checking (also used by the tests and the build) and loading, once per page. A missing
// or broken file means "no hotspots", never an error on screen.
import type { CommuteHotspot, HotspotType } from './types.ts';
import { BLR_BBOX, inBBox, type LngLat } from './spots.ts';

export const HOTSPOT_TYPES: readonly HotspotType[] = ['underpass', 'junction', 'service_road', 'flyover_ramp', 'road', 'layout'];
const DATE = /^\d{4}-\d{2}(-\d{2})?$/;

/** Everything wrong with one hotspot record (empty when it is valid). */
export function hotspotErrors(x: unknown): string[] {
  const e: string[] = [];
  const h = x as Partial<CommuteHotspot> | null;
  if (!h || typeof h !== 'object') return ['not an object'];
  const id = typeof h.id === 'string' ? h.id : '?';
  const bad = (m: string) => e.push(`${id}: ${m}`);
  if (typeof h.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(h.id)) bad('id must be a lower-case slug');
  if (typeof h.name !== 'string' || !h.name.trim()) bad('name missing');
  if (!HOTSPOT_TYPES.includes(h.type as HotspotType)) bad(`type ${String(h.type)} unknown`);
  const c = h.coord as LngLat | undefined;
  if (!Array.isArray(c) || c.length !== 2 || !c.every(Number.isFinite) || !inBBox(c, BLR_BBOX)) bad('coord must be [lon, lat] in Bengaluru Urban');
  if (!Array.isArray(h.ways) || !h.ways.every((w) => Number.isInteger(w) && w > 0)) bad('ways must be OSM way ids');
  if (h.thresholdMmHr !== undefined && !(typeof h.thresholdMmHr === 'number' && h.thresholdMmHr > 0)) bad('thresholdMmHr must be > 0 when set');
  if (!(typeof h.lowness === 'number' && h.lowness >= 0 && h.lowness <= 1)) bad('lowness must be 0..1');
  if (!(Number.isInteger(h.reportDays) && (h.reportDays as number) >= 0)) bad('reportDays must be a whole number');
  if (h.years !== null && !(Array.isArray(h.years) && h.years.length === 2 && h.years.every(Number.isInteger) && h.years[0] <= h.years[1])) bad('years must be [first, last] or null');
  if (!Array.isArray(h.sources) || h.sources.length > 3) bad('sources must be a list of at most 3');
  else {
    for (const s of h.sources) {
      if (!s || !DATE.test(s.date) || !/^https?:\/\/\S+$/.test(s.url) || typeof s.outlet !== 'string' || !s.outlet) bad(`bad source ${JSON.stringify(s)}`);
    }
    for (let i = 1; i < h.sources.length; i++) if (h.sources[i - 1].date < h.sources[i].date) bad('sources must be newest first');
    if (h.reportDays && !h.sources.length) bad('reported days but no source');
  }
  if (h.notes !== undefined && typeof h.notes !== 'string') bad('notes must be text');
  return e;
}

/** A FeatureCollection -> hotspots (coord from the geometry when the properties lack it), plus every problem found. */
export function parseHotspots(fc: unknown): { hotspots: CommuteHotspot[]; errors: string[] } {
  const f = fc as GeoJSON.FeatureCollection | null;
  if (!f || f.type !== 'FeatureCollection' || !Array.isArray(f.features)) return { hotspots: [], errors: ['not a FeatureCollection'] };
  const hotspots: CommuteHotspot[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const ft of f.features) {
    if (ft?.geometry?.type !== 'Point') {
      errors.push('feature without a Point geometry');
      continue;
    }
    const p = { ...(ft.properties as CommuteHotspot) };
    if (!Array.isArray(p.coord)) p.coord = ft.geometry.coordinates.slice(0, 2) as LngLat;
    const e = hotspotErrors(p);
    if (ids.has(p.id)) e.push(`${p.id}: duplicate id`);
    if (e.length) {
      errors.push(...e);
      continue;
    }
    ids.add(p.id);
    hotspots.push(p);
  }
  return { hotspots, errors };
}

let pending: Promise<CommuteHotspot[]> | null = null;

/** The valid hotspots of the committed registry (fetched once per page; [] when missing or broken). */
export function loadCommuteHotspots(): Promise<CommuteHotspot[]> {
  if (pending) return pending;
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const base = (env?.BASE_URL ?? '/').replace(/\/?$/, '/');
  pending = fetch(`${base}data/commute/hotspots.geojson`)
    .then((r) => (r.ok && !(r.headers.get('content-type') ?? '').includes('text/html') ? r.json() : null))
    .then((j) => parseHotspots(j).hotspots)
    .catch(() => []);
  return pending;
}
