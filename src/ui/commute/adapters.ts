// The Commute tab's one door to the engine (hotspots, forecast, risk, plan) and the router. The UI
// only talks to `backend` below, typed by the shared contract (src/commute/types.ts).
//
// Real: the hotspot registry (src/commute/registry.ts), the hotspot rain and outlooks
// (src/commute/forecast.ts + risk.ts), the planner (src/commute/plan.ts) and the city-wide router
// (src/route/, loaded on the first commute check so the Explore views never fetch it).
// STUB, until it lands:
//  - hotspots: while public/data/commute/hotspots.geojson is missing or empty, the news-reported
//    spots (public/data/news-spots.json) stand in, with a neutral lowness.
// Development only: ?fakeforecast=1 in `npm run dev` runs the real risk engine on a made-up storm
// that starts within the hour, so the wet case can be checked on a dry day.
import type { LngLat, NewsSpot } from '../../commute/spots.ts';
import type { CommuteHotspot, CommutePlan, HotspotOutlook, HotspotType, RiskLevel, RouteCandidate } from '../../commute/types.ts';
import { loadNewsSpots } from '../../commute/data.ts';
import { loadCommuteHotspots } from '../../commute/registry.ts';
import { COMMUTE_WEATHER_ATTRIBUTION, forecastOutlooks } from '../../commute/forecast.ts';
import { levelAt as engineLevelAt, outlooks as engineOutlooks, trackFromSums, type RainTrack } from '../../commute/risk.ts';
import { planCommute } from '../../commute/plan.ts';
import { BUCKET_MS } from '../../commute/config.ts';

export { BUCKET_MS };
const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env;
const DEV = !!env?.DEV;
const H = 3600e3;

export interface ForecastInfo {
  fetchedAt: number;
  /** "Open-Meteo, 38 points across the city, 15-minute steps" */
  label: string;
}

export interface CommuteBackend {
  /** what is real and what is still a stand-in, for the Sources section */
  status(): { hotspots: string; forecast: string; routes: string };
  loadHotspots(): Promise<CommuteHotspot[]>;
  /** per hotspot, 30-min buckets from t0 (floored to the half hour) for `hours`; rejects when there is no forecast */
  outlooks(hs: CommuteHotspot[], t0: number, hours: number): Promise<HotspotOutlook[]>;
  forecast(): ForecastInfo | null;
  routes(from: LngLat, to: LngLat): Promise<RouteCandidate[]>;
  plan(routes: RouteCandidate[], hs: CommuteHotspot[], outlooks: HotspotOutlook[], departure: number, now: number): CommutePlan;
}

export const floorBucket = (t: number) => Math.floor(t / BUCKET_MS) * BUCKET_MS;

/** level of one hotspot at time t (the bucket containing t); null outside its outlook */
export const levelAt = (o: HotspotOutlook | undefined, t: number): RiskLevel | null => engineLevelAt(o, t);

// ---------------------------------------------------------------- hotspots

let hotspotsFrom = 'not loaded yet';

const KIND_TYPE: Record<NewsSpot['kind'], HotspotType> = { underpass: 'underpass', junction: 'junction', road: 'road', layout: 'layout', other: 'road' };

/** STUB: news-reported spots as hotspots, until the curated registry ships */
function fromNews(spots: NewsSpot[]): CommuteHotspot[] {
  return spots.map((s) => ({
    id: s.id,
    name: s.name,
    type: KIND_TYPE[s.kind] ?? 'road',
    coord: s.coord,
    ways: [],
    lowness: 0.5,
    reportDays: s.count,
    years: [s.firstYear, s.lastYear],
    sources: [...s.reports].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 3).map((r) => ({ date: r.date, url: r.url, outlet: r.outlet })),
  }));
}

async function loadHotspots(): Promise<CommuteHotspot[]> {
  const curated = await loadCommuteHotspots();
  if (curated.length) {
    hotspotsFrom = `${curated.length} curated commute hotspots, each with its flood reports`;
    return curated;
  }
  const hs = fromNews(await loadNewsSpots());
  hotspotsFrom = `${hs.length} spots named in news reports of flooding (stand-in until the curated hotspot list ships)`;
  return hs;
}

// ---------------------------------------------------------------- forecast and risk

let info: ForecastInfo | null = null;
const fake = () => DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('fakeforecast');

/** Development only: a made-up storm, as Open-Meteo-style hourly sums (stamped at the end of each hour). */
export function fakeStormTrack(now: number): RainTrack {
  const h0 = Math.floor(now / H) * H;
  const storm = [1.5, 4, 8, 6, 2.5, 0.8]; // mm in the hour starting at h0 + k h
  const times = Array.from({ length: 30 + 48 }, (_, i) => h0 - 29 * H + i * H);
  const mm = times.map((t) => storm[Math.round((t - h0) / H) - 1] ?? 0);
  return trackFromSums(times, mm, H);
}

async function outlooks(hs: CommuteHotspot[], t0: number, hours: number): Promise<HotspotOutlook[]> {
  const from = floorBucket(t0);
  if (fake()) {
    const tr = fakeStormTrack(Date.now());
    info = { fetchedAt: Date.now(), label: 'Made-up storm (?fakeforecast=1, development only)' };
    const m = engineOutlooks(hs, () => tr, { from, to: from + hours * H });
    return hs.map((h) => m.get(h.id)).filter((o): o is HotspotOutlook => !!o);
  }
  const { outlooks: os, rain } = await forecastOutlooks(hs, from, hours);
  info = { fetchedAt: rain.fetchedAt, label: `Open-Meteo, ${rain.cells} forecast point${rain.cells === 1 ? '' : 's'} across the city, ${rain.resolution === '15min' ? '15-minute' : 'hourly'} steps` };
  return os;
}

// ---------------------------------------------------------------- routes

const ROUTES_WHAT = 'The fastest car route and up to two distinct alternatives (each at most 1.4× its time), at typical weekday peak-hour speeds';
let routesFrom = ROUTES_WHAT;

/**
 * The city-wide router (src/route/): its module and the road graph (~6.5 MB, kept by the service
 * worker) load on the first call, in a worker. Each `via` reads "via ORR and Sarjapur Road".
 */
async function routes(from: LngLat, to: LngLat): Promise<RouteCandidate[]> {
  const { planRoutes, preloadRoutes } = await import('../../route/index.ts');
  const index = await preloadRoutes();
  const day = new Date(index.built);
  if (!Number.isNaN(day.getTime())) routesFrom = `${ROUTES_WHAT}, on the roads as mapped on ${day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}`;
  const found = await planRoutes(from, to);
  if (!found.length) throw new Error('no drivable route between these two places (each must be within 1.5 km of a road)');
  return found;
}

// ---------------------------------------------------------------- the backend the UI uses

export const backend: CommuteBackend = {
  status: () => ({
    hotspots: hotspotsFrom,
    forecast: info ? `${info.label}. ${COMMUTE_WEATHER_ATTRIBUTION}` : COMMUTE_WEATHER_ATTRIBUTION,
    routes: routesFrom,
  }),
  loadHotspots,
  outlooks,
  forecast: () => info,
  routes,
  plan: (rs, hs, os, departure, now) => planCommute(rs, hs, os, departure, now),
};
