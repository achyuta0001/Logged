// The Commute tab's one door to the engine (hotspots, forecast, risk, plan) and the router. The UI
// only talks to `backend` below, typed by the shared contract (src/commute/types.ts).
//
// Real: the hotspot registry (src/commute/registry.ts), the hotspot rain and outlooks
// (src/commute/forecast.ts + risk.ts) and the planner (src/commute/plan.ts).
// STUB, until each lands:
//  - hotspots: while public/data/commute/hotspots.geojson is missing or empty, the news-reported
//    spots (public/data/news-spots.json) stand in, with a neutral lowness;
//  - routes: three placeholder lines (direct, and an arc either side) at ~22 km/h, until the
//    city-wide router (src/route/**) lands.
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

// ---------------------------------------------------------------- routes (STUB)

const KX = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);
const KY = 110574;

/** STUB: a quadratic arc from a to b bowed sideways by `bow` of the distance (0 = straight) */
function arc(a: LngLat, b: LngLat, bow: number, n = 48): LngLat[] {
  const kx = KX((a[1] + b[1]) / 2);
  const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * KY;
  const mx = (a[0] + b[0]) / 2 + (-dy * bow) / kx, my = (a[1] + b[1]) / 2 + (dx * bow) / KY;
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, u = 1 - t;
    return [u * u * a[0] + 2 * u * t * mx + t * t * b[0], u * u * a[1] + 2 * u * t * my + t * t * b[1]] as LngLat;
  });
}

async function routes(from: LngLat, to: LngLat): Promise<RouteCandidate[]> {
  const SPEED = 22 / 3.6; // m/s, a typical Bengaluru peak-hour average
  const make = (id: RouteCandidate['id'], bow: number, via: string): RouteCandidate => {
    const line = arc(from, to, bow);
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + Math.hypot((line[i][0] - line[i - 1][0]) * KX(line[i][1]), (line[i][1] - line[i - 1][1]) * KY));
    const len = cum[cum.length - 1] || 1;
    const lengthM = len * 1.25; // roads are longer than the line
    const durationS = lengthM / SPEED;
    return { id, line, lengthM, durationS, cumS: cum.map((m) => (m / len) * durationS), via };
  };
  return [make('A', 0.04, 'via a direct line, placeholder'), make('B', 0.3, 'via an arc to the left, placeholder'), make('C', -0.3, 'via an arc to the right, placeholder')];
}

// ---------------------------------------------------------------- the backend the UI uses

export const backend: CommuteBackend = {
  status: () => ({
    hotspots: hotspotsFrom,
    forecast: info ? `${info.label}. ${COMMUTE_WEATHER_ATTRIBUTION}` : COMMUTE_WEATHER_ATTRIBUTION,
    routes: 'Placeholder lines until the road router lands',
  }),
  loadHotspots,
  outlooks,
  forecast: () => info,
  routes,
  plan: (rs, hs, os, departure, now) => planCommute(rs, hs, os, departure, now),
};
