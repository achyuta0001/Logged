// Shared contract for the city-wide commute tool (hotspot registry, risk engine, routing, Commute tab).
// Pure types: the engine (src/commute/risk.ts), the router (src/route/**) and the UI (src/ui/commute*.ts)
// agree on these. Change a shape here only together with every user of it.
import type { LngLat } from './spots.ts';

export type HotspotType = 'underpass' | 'junction' | 'service_road' | 'flyover_ramp' | 'road' | 'layout';

/** One curated commute hotspot (public/data/commute/hotspots.geojson: a Point feature per hotspot, these as properties). */
export interface CommuteHotspot {
  id: string; // stable slug, e.g. "silk-board-junction"
  name: string;
  type: HotspotType;
  coord: LngLat;
  /** OSM way ids of the road segments that flood (for route intersection and display) */
  ways: number[];
  /** hourly rain (mm/h) at which it typically starts to waterlog; absent = the type default in config */
  thresholdMmHr?: number;
  /** 0..1 terrain lowness from the susceptibility / HAND layers */
  lowness: number;
  /** distinct days with sourced flood reports, and their year span */
  reportDays: number;
  years: [number, number] | null;
  /** up to 3 sources, newest first */
  sources: { date: string; url: string; outlet: string }[];
  notes?: string;
}

export type RiskLevel = 'clear' | 'watch' | 'likely' | 'severe';

/** Why a level was given: every input and the weighted terms (shown in the UI). */
export interface RiskExplain {
  rainNextMmHr: number;
  rainLast1hMm: number;
  rainLast24hMm: number;
  thresholdMmHr: number;
  lowness: number;
  reportDays: number;
  /** flood-model depth at the spot, m, when a pincode model covers it */
  modelDepthM?: number;
  /** term name -> contribution to the score */
  terms: Record<string, number>;
  score: number;
}

/** Risk for one hotspot in one 30-min bucket. */
export interface HotspotRisk {
  id: string;
  /** bucket start, ms epoch */
  t: number;
  level: RiskLevel;
  explain: RiskExplain;
}

/** Risk for one hotspot over the horizon, plus the window where it is likely or worse. */
export interface HotspotOutlook {
  id: string;
  buckets: HotspotRisk[];
  /** first and last bucket (ms) at likely or severe, else null */
  window: [number, number] | null;
}

/** A candidate route from the city-wide router. */
export interface RouteCandidate {
  id: 'A' | 'B' | 'C';
  /** [lon, lat] polyline */
  line: LngLat[];
  lengthM: number;
  /** typical travel time with no flooding, s */
  durationS: number;
  /** cumulative seconds from the start at each line vertex (same length as line) */
  cumS: number[];
  /** short human summary of the main roads, e.g. "via ORR and Sarjapur Road" */
  via: string;
}

/** A hotspot met along a route, with when the commuter reaches it. */
export interface RouteHotspotHit {
  id: string;
  /** seconds from departure until the hotspot is reached */
  atS: number;
  distanceM: number;
}

export type Advice =
  | { kind: 'go'; text: string }
  | { kind: 'leave_by'; at: number; text: string }
  | { kind: 'leave_after'; at: number; text: string }
  | { kind: 'use_route'; route: RouteCandidate['id']; text: string }
  | { kind: 'wfh'; text: string };

export interface RouteRisk {
  route: RouteCandidate['id'];
  /** worst hotspot level during the expected traversal */
  level: RiskLevel;
  hits: (RouteHotspotHit & { level: RiskLevel })[];
}

export interface CommutePlan {
  departure: number;
  routes: RouteRisk[];
  advice: Advice;
  /** the hotspots that drive the advice */
  drivers: string[];
}
