// Rain for every commute hotspot from Open-Meteo (free, keyless, CC BY 4.0), in as few requests as
// possible: hotspots are grouped into ~2 km cells (config FORECAST.clusterKm) and all the cells go in
// ONE request, since the forecast API takes comma-separated latitude / longitude lists (up to
// FORECAST.maxLocations per request). The answer is kept for the browser session (sessionStorage,
// 30 min, every storage call guarded: private windows and full storage just refetch).
import type { LngLat } from './spots.ts';
import type { CommuteHotspot, HotspotOutlook } from './types.ts';
import { FORECAST, HORIZON_H } from './config.ts';
import { outlooks, trackFromSums, type OutlookOptions, type RainTrack } from './risk.ts';

export const COMMUTE_WEATHER_ATTRIBUTION = 'Weather data by Open-Meteo.com (CC BY 4.0)';

const KM_LAT = 110.574;
const kmLon = (lat: number) => 111.32 * Math.cos((lat * Math.PI) / 180);

export interface RainCluster {
  /** grid cell key, stable for the same hotspot positions */
  key: string;
  center: LngLat;
  ids: string[];
}

/** Hotspots binned into cells of `km`; each cell is asked for at the mean position of its hotspots. */
export function clusterHotspots(hotspots: Pick<CommuteHotspot, 'id' | 'coord'>[], km = FORECAST.clusterKm): RainCluster[] {
  const lat0 = 12.97;
  const dLat = km / KM_LAT, dLon = km / kmLon(lat0);
  const cells = new Map<string, { ids: string[]; x: number; y: number }>();
  for (const h of hotspots) {
    const key = `${Math.floor(h.coord[0] / dLon)}:${Math.floor(h.coord[1] / dLat)}`;
    const c = cells.get(key) ?? { ids: [], x: 0, y: 0 };
    c.ids.push(h.id);
    c.x += h.coord[0];
    c.y += h.coord[1];
    cells.set(key, c);
  }
  return [...cells.entries()]
    .map(([key, c]) => ({ key, center: [Math.round((c.x / c.ids.length) * 1e4) / 1e4, Math.round((c.y / c.ids.length) * 1e4) / 1e4] as LngLat, ids: c.ids }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** One multi-location forecast request: hourly (and 15-minute) precipitation, a past day, unix times. */
export function forecastUrl(centers: LngLat[], minutely15 = FORECAST.minutely15): string {
  const lat = centers.map((c) => c[1].toFixed(4)).join(',');
  const lon = centers.map((c) => c[0].toFixed(4)).join(',');
  return (
    `${FORECAST.url}?latitude=${lat}&longitude=${lon}&hourly=precipitation` +
    (minutely15 ? '&minutely_15=precipitation' : '') +
    `&past_days=${FORECAST.pastDays}&forecast_days=${FORECAST.forecastDays}&timezone=GMT&timeformat=unixtime`
  );
}

interface OmLocation {
  hourly?: { time: number[]; precipitation: (number | null)[] };
  minutely_15?: { time: number[]; precipitation: (number | null)[] };
}

/**
 * One location's answer -> a 30-minute track. 15-minute values are used when present and not all
 * missing; otherwise hourly. Both are sums over the period ending at their timestamp.
 */
export function trackFromLocation(loc: OmLocation): { track: RainTrack; resolution: '15min' | 'hourly' } | null {
  const q = loc.minutely_15;
  if (q?.time?.length && q.precipitation?.some((v) => v != null)) {
    return { track: trackFromSums(q.time.map((s) => s * 1000), q.precipitation, 15 * 60e3), resolution: '15min' };
  }
  const h = loc.hourly;
  if (h?.time?.length && h.precipitation?.length === h.time.length) return { track: trackFromSums(h.time.map((s) => s * 1000), h.precipitation, 3600e3), resolution: 'hourly' };
  return null;
}

export interface HotspotRain {
  /** hotspot id -> its cell's rain */
  tracks: Map<string, RainTrack>;
  fetchedAt: number;
  /** 15min when every cell had 15-minute values, else hourly */
  resolution: '15min' | 'hourly';
  /** HTTP requests made (0 when served from the session cache) */
  requests: number;
  cells: number;
  attribution: string;
}

/** Parse the answers (one array element per center, or a single object for one center) into tracks per hotspot. */
export function tracksFromResponses(bodies: unknown[], clusters: RainCluster[]): Pick<HotspotRain, 'tracks' | 'resolution'> {
  const locs: OmLocation[] = bodies.flatMap((b) => (Array.isArray(b) ? b : [b])) as OmLocation[];
  if (locs.length !== clusters.length) throw new Error(`Open-Meteo: ${locs.length} locations for ${clusters.length} cells`);
  const tracks = new Map<string, RainTrack>();
  let all15 = true;
  clusters.forEach((c, i) => {
    const t = trackFromLocation(locs[i]);
    if (!t) return;
    if (t.resolution !== '15min') all15 = false;
    for (const id of c.ids) tracks.set(id, t.track);
  });
  return { tracks, resolution: all15 && tracks.size ? '15min' : 'hourly' };
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function cacheRead(key: string, ttl: number, now: number): { t: number; bodies: unknown[] } | null {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as { t: number; bodies: unknown[] };
    return now - v.t <= ttl && Array.isArray(v.bodies) ? v : null;
  } catch {
    return null;
  }
}

function cacheWrite(key: string, value: { t: number; bodies: unknown[] }): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable or full: the next call fetches again */
  }
}

/** a short stable hash of the cell list, so a changed registry does not reuse another list's answer */
function hashKey(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

const inflight = new Map<string, Promise<HotspotRain>>();

/**
 * Rain tracks for every hotspot: one Open-Meteo request per FORECAST.maxLocations cells (one for the
 * whole registry), cached for the session. Rejects when the forecast cannot be had; the caller shows
 * that instead of a level.
 */
export function fetchHotspotRain(
  hotspots: Pick<CommuteHotspot, 'id' | 'coord'>[],
  opts: { fetch?: typeof fetch; now?: number } = {},
): Promise<HotspotRain> {
  const clusters = clusterHotspots(hotspots);
  const key = `omc:${FORECAST.pastDays}:${FORECAST.forecastDays}:${FORECAST.minutely15 ? 15 : 60}:${hashKey(clusters.map((c) => c.key + c.ids.join(',')).join(';'))}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async (): Promise<HotspotRain> => {
    const now = opts.now ?? Date.now();
    const hit = cacheRead(key, FORECAST.cacheTtlMs, now);
    let bodies: unknown[], fetchedAt: number, requests = 0;
    if (hit) {
      bodies = hit.bodies;
      fetchedAt = hit.t;
    } else {
      const f = opts.fetch ?? fetch;
      bodies = [];
      for (let i = 0; i < clusters.length; i += FORECAST.maxLocations) {
        const part = clusters.slice(i, i + FORECAST.maxLocations);
        const res = await f(forecastUrl(part.map((c) => c.center)));
        requests++;
        const body = (await res.json().catch(() => null)) as { error?: boolean; reason?: string } | unknown[] | null;
        if (!res.ok || !body || (!Array.isArray(body) && (body as { error?: boolean }).error)) {
          throw new Error(`Open-Meteo: ${(body as { reason?: string } | null)?.reason ?? `HTTP ${res.status}`}`);
        }
        bodies.push(part.length === 1 && !Array.isArray(body) ? [body] : body);
      }
      fetchedAt = now;
      cacheWrite(key, { t: fetchedAt, bodies });
    }
    const { tracks, resolution } = tracksFromResponses(bodies, clusters);
    return { tracks, fetchedAt, resolution, requests, cells: clusters.length, attribution: COMMUTE_WEATHER_ATTRIBUTION };
  })();
  inflight.set(key, p);
  p.catch(() => undefined).finally(() => inflight.delete(key));
  return p;
}

/**
 * The whole engine in one call, for the Commute tab: fetch (or reuse) the rain, then score every
 * hotspot in 30-minute buckets from `from` for `hours` (default HORIZON_H; any horizon up to the end
 * of the forecast). `depthAt` passes flood-model water at a spot when a pincode model has run.
 */
export async function forecastOutlooks(
  hotspots: CommuteHotspot[],
  from: number,
  hours = HORIZON_H,
  opts: { fetch?: typeof fetch; now?: number; depthAt?: OutlookOptions['depthAt'] } = {},
): Promise<{ outlooks: HotspotOutlook[]; rain: HotspotRain }> {
  const rain = await fetchHotspotRain(hotspots, opts);
  const map = outlooks(hotspots, (id) => rain.tracks.get(id), { from, to: from + hours * 3600e3, depthAt: opts.depthAt });
  return { outlooks: hotspots.map((h) => map.get(h.id)).filter((o): o is HotspotOutlook => !!o), rain };
}
